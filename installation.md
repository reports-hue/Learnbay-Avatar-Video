# Learnbay Video Generator — Installation

This guide covers local development, a single-server production build, Docker, and PM2 on AWS, Google Cloud, or Microsoft Azure. Run commands from the repository root unless a step says otherwise.

> **Security:** This checkout does not enforce user login. `LOGIN_EMAIL`, `LOGIN_PASSWORD`, and `SESSION_SECRET` do not protect its routes. Keep development private. Before opening a cloud deployment to the internet, put an authenticated gateway or access-controlled reverse proxy in front of it. Do not expose port 8080 publicly.

## 1. Requirements

- Git, Node.js **24**, and pnpm **10.26.1** for non-Docker installs.
- An Azure AI Speech resource in an avatar-supported region (`westus2`, `westeurope`, or `southeastasia`) and an Azure OpenAI resource with the script model deployed.
- A full FFmpeg build with the `drawtext` filter, ImageMagick's `magick` command, and fonts for video rendering. The Dockerfile installs these. On Ubuntu 24.04 for a local or PM2 install:

  ```bash
  sudo apt-get update
  sudo apt-get install -y git ffmpeg imagemagick fonts-dejavu-core
  # Ubuntu's ImageMagick package may provide "convert" instead of "magick".
  if ! command -v magick >/dev/null && command -v convert >/dev/null; then
    sudo ln -s "$(command -v convert)" /usr/local/bin/magick
  fi
  ffmpeg -hide_banner -filters | grep drawtext
  magick -version
  ```

  Install Node.js 24 using the [official Node.js instructions](https://nodejs.org/en/download), then run `npm install -g pnpm@10.26.1`. If `drawtext` is missing, install a full FFmpeg build and set `FFMPEG_PATH` to its binary.

## 2. Configure the environment

```bash
cp .env.example .env
chmod 600 .env
# Edit .env locally; never commit it.
```

Replace the example values with your own. The `.env` file is ignored by Git. The API reads environment variables from its process; it does **not** automatically load `.env`, so follow the export step in the local and PM2 instructions below. Docker Compose loads it through `env_file`.

| Variable | When needed | Purpose |
|---|---|---|
| `AZURE_SPEECH_KEY` | Required for avatar/TTS | Azure AI Speech resource key. |
| `AZURE_SPEECH_REGION` | Required for avatar/TTS | Region of that Speech resource; use an avatar-supported region. |
| `AZURE_OPENAI_API_KEY` | Required for scripts | Azure OpenAI resource key. |
| `AZURE_OPENAI_ENDPOINT` | Required for scripts | Azure OpenAI resource endpoint, including `https://`. |
| `AZURE_OPENAI_DEPLOYMENT` | Required for scripts | Name of your deployed text model; defaults to `gpt-4o-mini` if omitted. |
| `PORT` | Required for API | `8080` in the supplied setup. |
| `NODE_ENV` | Required for production | `production` enables serving the built frontend. The API's `dev` script sets development mode itself. |
| `AZURE_IMAGE_API_KEY`, `AZURE_IMAGE_ENDPOINT`, `AZURE_IMAGE_DEPLOYMENT` | Optional for AI backgrounds | Dedicated image deployment credentials. Without dedicated values, image generation uses the OpenAI endpoint/key and looks for `gpt-image-1`; that model must exist for this feature. |
| `ELEVENLABS_API_KEY` | Optional | Server-side ElevenLabs voice key; a key can also be supplied through voice settings. |
| `PUBLIC_URL` | Needed for ElevenLabs on a public deployment | Public HTTPS origin, e.g. `https://video.example.com`, so Azure can fetch generated audio. If omitted, the server uses the incoming request host; set it explicitly behind a proxy. Localhost is not reachable by Azure. |
| `PEXELS_API_KEY` | Optional | Stock b-roll search. |
| `FFMPEG_PATH` | Optional | Path to a full FFmpeg binary if it is not on `PATH`. |
| `LOG_LEVEL` | Optional | Server log level; defaults to `info`. |
| `BASE_PATH` | Frontend build/dev command only | Set to `/` with the supplied routes; not needed in `.env` for the production API. |
| `VITE_FRONTEND_PORT` | Optional, development API only | Defaults to `24396` when the API proxies the Vite server. |

Do not put actual credentials in documentation, Docker images, or Git. For cloud deployments, store credentials in your provider's secret manager or in a protected, untracked `.env` file on the VM.

## 3. Run locally without Docker

### Development: two terminals

```bash
git clone https://github.com/YOUR_ORG/YOUR_REPO.git learnbay-video-generator
cd learnbay-video-generator
pnpm install --frozen-lockfile
cp .env.example .env
# Edit .env with your Azure resource values.
```

Open both terminals in the `learnbay-video-generator` repository root. Terminal 1 — API:

```bash
set -a; . ./.env; set +a
PORT=8080 pnpm --filter @workspace/api-server run dev
```

Terminal 2 — frontend:

```bash
PORT=24396 BASE_PATH=/ pnpm --filter @workspace/video-generator run dev
```

Open `http://localhost:24396`. Vite forwards `/api` calls to the API on port 8080. Check `http://localhost:8080/api/healthz` if the UI cannot reach the API.

### Production-style single process

```bash
PORT=24396 BASE_PATH=/ pnpm --filter @workspace/video-generator run build
pnpm --filter @workspace/api-server run build
set -a; . ./.env; set +a
NODE_ENV=production PORT=8080 pnpm --filter @workspace/api-server run start
```

Open `http://localhost:8080`. This one server serves both the API and the built frontend.

## 4. Run with Docker

Install Docker Engine with the Compose plugin on your machine or VM ([official Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/)). From the repository root:

```bash
cp .env.example .env
# Edit .env; set NODE_ENV=production and PORT=8080.
docker compose up -d --build
docker compose ps
curl -f http://localhost:8080/api/healthz
docker compose logs -f app
```

Open `http://localhost:8080`. The supplied Compose file binds only to `127.0.0.1:8080`; for remote access, use a reverse proxy on ports 80/443 (below), not a public port 8080. The `video-outputs` and `video-assets` named volumes hold generated files and brand assets across container restarts. Back them up. `docker compose down` preserves them; **`docker compose down -v` deletes them**.

To update:

```bash
git pull
docker compose up -d --build
docker compose ps
```

The Docker image includes a system FFmpeg build with `drawtext`, ImageMagick, and fonts. Do not use a bare Node image or omit the persistent volumes for real deployments.

## 5. Prepare an AWS, Google Cloud, or Azure VM

Use an Ubuntu 24.04 VM with at least **2 vCPUs, 4 GB RAM, and 30 GB storage** as a starting point; increase disk space for retained videos. The app keeps jobs in process memory, so start with **one instance**. Multiple replicas or scale-to-zero platforms need a shared job queue and durable storage before they can reliably run generation jobs.

| Provider | VM setup | Network and storage |
|---|---|---|
| AWS | Create an EC2 Ubuntu 24.04 instance and assign an Elastic IP. | Security group: SSH (22) from your IP only; HTTP (80) and HTTPS (443) as needed. Attach a persistent EBS volume or back up the instance disk. |
| Google Cloud | Create a Compute Engine Ubuntu 24.04 VM with a reserved external IP. | VPC firewall: restrict SSH to your IP and allow HTTP/HTTPS. Use a persistent disk for outputs and backups. |
| Microsoft Azure | Create an Azure Virtual Machine with Ubuntu 24.04 and a static public IP. | NSG: restrict SSH to your IP and allow HTTP/HTTPS. Use a managed disk for outputs and backups. |

Point your domain's DNS A record to the VM's public IP. Do **not** create a public firewall rule for port 8080. SSH into the VM, clone the repository, copy/edit `.env`, and select **either Docker (section 6)** or **PM2 (section 7)**. Set `PUBLIC_URL=https://your-domain.com` if using ElevenLabs voices. Configure authentication before granting access to others.

## 6. Cloud VM deployment with Docker (AWS / Google Cloud / Azure)

On the VM, install Docker Engine and the Compose plugin using the [official instructions](https://docs.docker.com/engine/install/ubuntu/), then:

```bash
git clone https://github.com/YOUR_ORG/YOUR_REPO.git learnbay-video-generator
cd learnbay-video-generator
cp .env.example .env
chmod 600 .env
# Edit .env with the production values and PUBLIC_URL.
docker compose up -d --build
docker compose ps
curl -f http://127.0.0.1:8080/api/healthz
```

Complete the HTTPS reverse-proxy steps in section 8. Keep `artifacts/api-server/outputs` and `artifacts/api-server/assets` on backed-up storage. The Compose named volumes are on the VM by default; attach/mount a persistent disk and configure the Docker data directory or use explicit bind mounts if the VM may be replaced.

For a managed container service instead of a VM: AWS ECS/Fargate uses ECR + EFS + an ALB; Google Cloud can use GKE with a persistent volume; Azure can use AKS with persistent storage. Pass environment values as managed secrets, expose container port 8080 behind HTTPS, and probe `/api/healthz`. Avoid scale-to-zero and multi-replica configurations until jobs and storage are moved out of process memory/local disk.

## 7. Cloud VM deployment with PM2 (AWS / Google Cloud / Azure)

On the Ubuntu VM, install Node.js 24 and pnpm 10.26.1 as in section 1, plus PM2:

```bash
sudo apt-get update
sudo apt-get install -y git ffmpeg imagemagick fonts-dejavu-core
if ! command -v magick >/dev/null && command -v convert >/dev/null; then
  sudo ln -s "$(command -v convert)" /usr/local/bin/magick
fi
sudo npm install -g pnpm@10.26.1 pm2
git clone https://github.com/YOUR_ORG/YOUR_REPO.git learnbay-video-generator
cd learnbay-video-generator
pnpm install --frozen-lockfile
cp .env.example .env
chmod 600 .env
# Edit .env with the production values and PUBLIC_URL.
PORT=24396 BASE_PATH=/ pnpm --filter @workspace/video-generator run build
pnpm --filter @workspace/api-server run build
mkdir -p logs
set -a; . ./.env; set +a
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # Run the additional command printed by PM2.
curl -f http://127.0.0.1:8080/api/healthz
```

PM2 uses the exported environment from `.env` and starts `learnbay-api` on port 8080. The repository's `ecosystem.config.cjs` does not load `.env` itself; export it before starting or refreshing the process.

To update code or changed environment values:

```bash
git pull
pnpm install --frozen-lockfile
PORT=24396 BASE_PATH=/ pnpm --filter @workspace/video-generator run build
pnpm --filter @workspace/api-server run build
set -a; . ./.env; set +a
pm2 restart learnbay-api --update-env
pm2 save
pm2 logs learnbay-api
```

Generated videos live in `artifacts/api-server/outputs/` and brand assets in `artifacts/api-server/assets/`; put these directories on backed-up storage. PM2 does not make in-memory jobs survive a process restart.

## 8. HTTPS reverse proxy for a cloud VM

Install Nginx and point it to the local app, whether it runs under Docker or PM2:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo tee /etc/nginx/sites-available/learnbay >/dev/null <<'EOF'
server {
    listen 80;
    server_name your-domain.com;
    client_max_body_size 50M;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 600s;
    }
}
EOF
sudo ln -s /etc/nginx/sites-available/learnbay /etc/nginx/sites-enabled/learnbay
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d your-domain.com
```

Replace `your-domain.com` with your real DNS name. Add an authenticated gateway (for example your provider's identity-aware proxy or Nginx authentication) before allowing users in; TLS alone does not provide application login. Then set `PUBLIC_URL` to the resulting `https://` origin if ElevenLabs is enabled.

## Troubleshooting

- **API starts but the page is missing:** Build the frontend with `PORT=24396 BASE_PATH=/`, then start the API with `NODE_ENV=production`. In development, run both servers.
- **Video render fails with `No such filter: drawtext`:** Install a full FFmpeg build; verify `ffmpeg -filters | grep drawtext`; set `FFMPEG_PATH` if necessary.
- **SVG logo conversion fails:** Install ImageMagick and ensure `magick -version` works.
- **ElevenLabs audio fetch fails:** Set `PUBLIC_URL` to a reachable HTTPS origin. Azure cannot fetch audio from `localhost`.
- **Videos disappear after replacement/restart:** Back up or mount persistent `outputs/` and `assets/`; do not remove Docker volumes with `down -v`.
- **Health check:** `curl -f http://127.0.0.1:8080/api/healthz`. Check `docker compose logs app` or `pm2 logs learnbay-api` for startup errors.