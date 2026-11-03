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
COPY app/public/data/ ./app/public/data/

FROM node:22-bookworm-slim AS frontend

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY app/package.json app/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY app/ ./
RUN pnpm build

FROM python-app AS runtime

COPY --from=frontend /app/dist ./app/dist

RUN useradd --system --uid 10001 --create-home app

ENV PATH="/app/.venv/bin:${PATH}" \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080
USER app

CMD ["sh", "-c", "exec python -m biosai serve --schema app/public/data/bios_schema.json --host \"$HOST\" --port \"$PORT\""]
