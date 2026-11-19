FROM python:3.12-slim
ARG APP_UID=1000
ARG APP_GID=1000
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080 HOST=0.0.0.0 DATA_DIR=/data
WORKDIR /app
COPY server.py ./
COPY static ./static
RUN mkdir -p /data && chown ${APP_UID}:${APP_GID} /data
USER ${APP_UID}:${APP_GID}
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD python -c "import json,urllib.request; r=json.load(urllib.request.urlopen('http://127.0.0.1:8080/api/health',timeout=3)); assert r.get('ok') and r.get('service')=='solid-studio'"
CMD ["python", "-u", "server.py"]
