FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY pyproject.toml README.md ./
COPY fedplat ./fedplat
RUN pip install --no-cache-dir .

CMD ["sh", "-c", "uvicorn fedplat.app:app --host 0.0.0.0 --port ${PORT:-8000}"]
