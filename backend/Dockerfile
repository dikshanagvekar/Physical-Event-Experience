FROM python:3.12-slim

WORKDIR /app

# Install dependencies first (Docker cache layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY . .

# Cloud Run requires PORT env var
ENV PORT=8080

# Use uvicorn with production settings
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 2 --log-level info"]
