"""The loudness pass: Voxtral's wav is quiet, and the intercom is not.

Every assertion here is about measured numbers, not intent: the peak before,
the peak after, the gain applied, and what happens to a wav that must not be
touched.
"""

from __future__ import annotations

import math
import struct

from worker.shared.mistral_ai import normalise_wav

RATE = 24000
BITS = 16
CHANNELS = 1


def make_wav(samples: list[int]) -> bytes:
    """A minimal 16-bit mono wav, with a streamed-style 0xFFFFFFFF data size."""

    data = struct.pack(f"<{len(samples)}h", *samples)
    header = (
        b"RIFF"
        + (0).to_bytes(4, "little")
        + b"WAVE"
        + b"fmt "
        + (16).to_bytes(4, "little")
        + struct.pack("<HHIIHH", 1, CHANNELS, RATE, RATE * 2, 2, BITS)
        + b"data"
        + (0xFFFFFFFF).to_bytes(4, "little")
    )
    return header + data


def peak_of(raw: bytes) -> int:
    marker = raw.index(b"data") + 8
    count = (len(raw) - marker) // 2
    return max(abs(value) for value in struct.unpack_from(f"<{count}h", raw, marker))


def test_quiet_audio_is_raised_to_the_target():
    quiet = [int(32767 * 10 ** (-12 / 20))] * 64 + [0] * 64
    boosted, facts = normalise_wav(make_wav(quiet), -1.0)

    assert facts["normalised"] is True
    assert facts["peak_dbfs_before"] == -12.0
    assert facts["peak_dbfs"] == -1.0
    assert facts["gain_db"] == 11.0
    assert 32767 * 10 ** (-1 / 20) - 2 <= peak_of(boosted) <= 32767
    # the header survives untouched: this is still a playable wav
    assert boosted[:4] == b"RIFF" and boosted[8:12] == b"WAVE"


def test_audio_already_loud_is_left_alone():
    loud = [30000, -30000, 20000, -20000]
    raw = make_wav(loud)
    same, facts = normalise_wav(raw, -1.0)

    assert facts["normalised"] is False
    assert facts["gain_db"] == 0.0
    assert same == raw


def test_gain_is_capped_so_a_whisper_does_not_become_hiss():
    whisper = [3, -3, 2, -2]
    _, facts = normalise_wav(make_wav(whisper), -1.0)

    assert facts["normalised"] is True
    assert facts["gain_db"] <= 18.0


def test_silence_and_rubbish_are_reported_not_guessed():
    _, silent = normalise_wav(make_wav([0] * 32), -1.0)
    assert silent == {"normalised": False, "reason": "silence"}

    _, rubbish = normalise_wav(b"not a wav at all", -1.0)
    assert rubbish == {"normalised": False, "reason": "not a wav"}


def test_target_is_a_setting_not_a_constant():
    """A quieter building should be able to ask for a quieter intercom."""

    quiet = [int(32767 * 10 ** (-18 / 20))] * 32
    _, facts = normalise_wav(make_wav(quiet), -6.0)
    assert facts["peak_dbfs"] == -6.0
    assert math.isclose(facts["gain_db"], 12.0, abs_tol=0.1)
