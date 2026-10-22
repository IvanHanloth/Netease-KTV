# Separation service: python-audio-separator + a small FastAPI job API.
# SEPARATOR_TAG: cpu (default) | gpu (NVIDIA, CUDA) — see beveradb/audio-separator tags.
ARG SEPARATOR_TAG=cpu
FROM beveradb/audio-separator:${SEPARATOR_TAG}

WORKDIR /app
COPY requirements.txt .
# Some base images mark the system Python as externally managed (PEP 668).
ENV PIP_BREAK_SYSTEM_PACKAGES=1
RUN python3 -m pip install --no-cache-dir -r requirements.txt

COPY app.py .

ENV MODEL_DIR=/models \
    ALLOWED_ROOT=/data \
    PORT=9000 \
    PYTHONUNBUFFERED=1

EXPOSE 9000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9000/health', timeout=3)" || exit 1

# The base image's entrypoint is the audio-separator CLI; replace it with our API.
ENTRYPOINT ["python3", "app.py"]
