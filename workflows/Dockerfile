# Managed deployment image for the Le Concierge workflows worker.
# No key is baked in: the platform injects a service-account token.

FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY apps ./apps

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH="/app/apps/worker/src"

CMD ["python", "-m", "worker.entrypoints.worker"]
