import { useEffect, useState } from "react";
import { apiBase, openLive, type Visit } from "@le-concierge/ui";
import "./stage.css";

/** The demo stage (`#stage`): the door, the resident's phone and the workflow, at once. */

// The phone frame shows the resident app from the same host when the door is served under /door/
// (harmony hosts both apps on one origin); otherwise the Vercel deployment. VITE_RESIDENT_URL overrides.
const RESIDENT_URL =
  (import.meta.env.VITE_RESIDENT_URL as string | undefined) ??
  (import.meta.env.BASE_URL === "/door/" ? `${window.location.origin}/` : "https://le-concierge-resident.vercel.app");

type StepStatus = "scheduled" | "started" | "completed" | "failed";
interface Step {
  activity: string;
  status: StepStatus;
  at: string | null;
  model?: string;
}
interface Steps {
  executionId: string;
  steps: Step[];
  waiting: boolean;
  finished: boolean;
}

type Lit = "idle" | "active" | "waiting" | "done" | "failed";

const STAGES: { label: string; activity: RegExp; model?: string }[] = [
  { label: "Describe snapshot", activity: /^describe_snapshot$/, model: "mistral-small-latest" },
  { label: "Match face", activity: /^match_face$/, model: "face-api.js" },
  { label: "Transcribe", activity: /^transcribe/, model: "voxtral-mini-latest" },
  { label: "Decide", activity: /^decide/, model: "mistral-small-latest" },
  { label: "Waiting for resident", activity: /^post_visit$/, model: "resident-decision signal" },
  { label: "Speak reply", activity: /^speak_reply$/, model: "voxtral-mini-tts" },
  { label: "Logged", activity: /log_event$/ },
];

function litFor(status: StepStatus | undefined): Lit {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "started" || status === "scheduled") return "active";
  return "idle";
}

/** One lit state and model per stage, from the execution's steps. */
export function stageView(data: Steps | null): { label: string; lit: Lit; model?: string }[] {
  const steps = data?.steps ?? [];
  const find = (re: RegExp) => [...steps].reverse().find((s) => re.test(s.activity));
  return STAGES.map((stage, i) => {
    const step = find(stage.activity);
    if (i === 4) {
      // The wait: on while the run sits on the resident-decision timer,
      // done once anything after it (speaking the reply) has begun.
      const after = find(STAGES[5].activity) || find(STAGES[6].activity);
      const lit: Lit = after || (data?.finished && step) ? "done" : data?.waiting || step ? "waiting" : "idle";
      return { label: stage.label, lit, model: stage.model };
    }
    return { label: stage.label, lit: litFor(step?.status), model: step?.model ?? stage.model };
  });
}

function useApiUp(): boolean | null {
  const [up, setUp] = useState<boolean | null>(apiBase ? null : false);
  useEffect(() => {
    if (!apiBase) return;
    let alive = true;
    const check = async () => {
      try {
        const response = await fetch(`${apiBase}/health`);
        if (alive) setUp(response.ok);
      } catch {
        if (alive) setUp(false);
      }
    };
    void check();
    const timer = setInterval(check, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return up;
}

/** The latest visit in the building, from the building-wide `/live?scope=door` feed. */
function useLatestVisit(): Visit | null {
  const [visit, setVisit] = useState<Visit | null>(null);
  useEffect(() => {
    const live = openLive({ scope: "door" }, (next) =>
      setVisit((current) => (!current || next.id === current.id || next.at >= current.at ? next : current)),
    );
    return () => live.close();
  }, []);
  return visit;
}

/** Poll the execution's steps every second until the run finishes. */
function useSteps(executionId: string | null | undefined): Steps | null {
  const [data, setData] = useState<Steps | null>(null);
  useEffect(() => {
    setData(null);
    if (!apiBase || !executionId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      let finished = false;
      try {
        const response = await fetch(`${apiBase}/executions/${encodeURIComponent(executionId)}/steps`);
        if (response.ok) {
          const next = (await response.json()) as Steps;
          finished = next.finished;
          if (alive) setData(next);
        }
      } catch {
        /* the next poll tries again */
      }
      if (alive && !finished) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [executionId]);
  return data;
}

function Mark({ lit }: { lit: Lit }) {
  return (
    <svg className="stage-mark" viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="16" />
      {lit === "done" && <path d="M12.5 20.5l5 5 10-11" />}
      {lit === "failed" && <path d="M14 14l12 12M26 14L14 26" />}
      {(lit === "active" || lit === "waiting") && <circle className="stage-dot" cx="20" cy="20" r="5" />}
    </svg>
  );
}

export default function StageScreen() {
  const up = useApiUp();
  const visit = useLatestVisit();
  const data = useSteps(visit?.executionId);
  const view = stageView(data);
  const doorSrc = `${window.location.pathname}${window.location.search}#door`;

  return (
    <div className="stage">
      <header className="stage-top">
        <h1 className="stage-title">
          <span className="stage-health" data-up={up === true} aria-label={up ? "API reachable" : "API unreachable"} />
          Le Concierge — live
        </h1>
        <p className="mono small muted">
          {visit ? `visit ${visit.id} · flat ${visit.flat ?? "?"} · ${visit.status}` : "waiting for a visitor"}
        </p>
      </header>

      <section className="stage-door" aria-label="The door">
        <iframe title="The door" src={doorSrc} allow="camera; microphone; autoplay; fullscreen" />
      </section>

      <section className="stage-phone-wrap" aria-label="The resident's phone">
        <div className="stage-phone">
          <iframe title="The resident's phone" src={RESIDENT_URL} allow="camera; microphone; autoplay" />
        </div>
      </section>

      <aside className="stage-notes" aria-label="This visit">
        <p className="stage-kicker mono">This visit</p>
        <p className="stage-words">{visit?.transcript ? `“${visit.transcript}”` : "—"}</p>
        <p className="mono small muted">
          {visit?.executionId ? `execution ${visit.executionId.slice(0, 8)}…` : "no execution yet"}
        </p>
      </aside>

      <ol className="stage-strip" aria-label="Workflow steps">
        {view.map((step, i) => (
          <li key={step.label} className="stage-step" data-lit={step.lit}>
            <Mark lit={step.lit} />
            <span className="stage-step-label">
              <span className="mono stage-step-n">{i + 1}</span> {step.label}
            </span>
            <span className="mono stage-step-model">{step.model ?? " "}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
