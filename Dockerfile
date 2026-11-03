FROM ghcr.io/astral-sh/uv:python3.12-bookworm AS python-app

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY biosai/ ./biosai/
COPY boards/ ./boards/
COPY kb/ ./kb/
COPY out/z890-eagle-f5/bios_schema.json ./out/z890-eagle-f5/bios_schema.json

RUN uv run --no-sync python -m biosai bundle \
    out/z890-eagle-f5/bios_schema.json \
    boards/gigabyte-z890-eagle-wifi7

FROM node:22-bookworm-slim AS frontend

WORKDIR /app

RUN corepack enable
COPY app/package.json app/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY app/ ./
COPY --from=python-app /app/app/public/data ./public/data
RUN pnpm build

FROM python-app AS runtime

COPY --from=frontend /app/dist ./app/dist

RUN useradd --system --uid 10001 --create-home app

ENV PATH="/app/.venv/bin:${PATH}" \
    HOST=0.0.0.0 \
    PORT=8765

EXPOSE 8765
USER app

CMD ["sh", "-c", "exec python -m biosai serve --host \"$HOST\" --port \"$PORT\""]
