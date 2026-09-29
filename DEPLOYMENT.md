# Learnbay Personal Video Generator — Deployment Guide

For current Node.js, pnpm, Docker, PM2, and cloud setup instructions, use [installation.md](installation.md). This older guide is retained for deployment background and may contain outdated commands.

Three deployment paths are covered:

| Option | Best For |
|--------|----------|
| [A — Local Computer](#option-a-local-computer) | Development, testing, demos |
| [B — AWS EC2 + PM2](#option-b-aws-ec2--pm2) | Production on a single EC2 instance |
| [C — AWS Docker (ECS / EC2)](#option-c-aws-docker) | Containerised, scalable production |

---

## Prerequisites (all options)

### System Requirements

| Tool | Version |
|------|---------|
| Node.js | 20 LTS or higher |
| pnpm | 9.x (`npm install -g pnpm@9`) |
| FFmpeg | 7.x (bundled via `ffmpeg-static` — no manual install needed) |

### Required Azure Services

| Service | Secret name | Where to get it |
|---------|-------------|-----------------|
| Azure AI Speech | `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | Azure Portal → Speech resource → Keys & Endpoint |
| Azure OpenAI (GPT-4o-mini) | `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_DEPLOYMENT` | Azure Portal → Azure OpenAI resource |
| Azure OpenAI (gpt-image-1) | `AZURE_IMAGE_API_KEY` / `AZURE_IMAGE_ENDPOINT` | Azure Portal → Model deployments |

> **Azure Speech region note:** Batch Avatar synthesis is only available in `westus2`, `westeurope`, and `southeastasia`. Your Speech resource must be in one of these regions.

---

## Environment Variables Reference

Create a `.env` file in the project root (copy from `.env.example`):

```env
# ── Server ─────────────────────────────────────────────
PORT=8080
NODE_ENV=production
SESSION_SECRET=change-this-to-a-long-random-string

# ── Azure Speech (Avatar + TTS) ─────────────────────────
AZURE_SPEECH_KEY=your_speech_key_here
AZURE_SPEECH_REGION=westus2

# ── Azure OpenAI (Script generation + Brand theme) ──────
AZURE_OPENAI_API_KEY=your_openai_key_here
AZURE_OPENAI_ENDPOINT=https://YOUR-RESOURCE.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini

# ── Azure OpenAI (Background image generation) ──────────
AZURE_IMAGE_API_KEY=your_image_key_here
AZURE_IMAGE_ENDPOINT=https://YOUR-RESOURCE.cognitiveservices.azure.com
AZURE_IMAGE_DEPLOYMENT=gpt-image-1

# ── Public URL (used for ElevenLabs audio serving) ──────
PUBLIC_URL=https://your-domain.com

# ── Optional ─────────────────────────────────────────────
# ELEVENLABS_API_KEY=your_key    # only if you use ElevenLabs voices
```

---

## Option A: Local Computer

### 1. Clone and install dependencies

```bash
git clone https://github.com/your-org/learnbay-video-generator.git
cd learnbay-video-generator
pnpm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
# Edit .env with your actual Azure credentials
```

### 3. Start in development mode

This runs the API server (port 8080) and the Vite frontend (port 24396) separately:

```bash
# Terminal 1 — API server
PORT=8080 pnpm --filter @workspace/api-server run dev

# Terminal 2 — Frontend (Vite dev server)
PORT=24396 BASE_PATH=/ pnpm --filter @workspace/video-generator run dev
```

Open `http://localhost:24396` in your browser.

> In dev mode, the frontend proxies `/api` calls to `localhost:8080` automatically via Vite's proxy config.

### 4. Start in production mode (single server)

```bash
# Step 1 — Build the frontend (outputs to artifacts/video-generator/dist/public)
PORT=24396 BASE_PATH=/ pnpm --filter @workspace/video-generator run build

# Step 2 — Build the API server (outputs to artifacts/api-server/dist/index.mjs)
pnpm --filter @workspace/api-server run build

# Step 3 — Run (the API server also serves the pre-built frontend)
PORT=8080 NODE_ENV=production node artifacts/api-server/dist/index.mjs
```

Open `http://localhost:8080` in your browser.

---

## Option B: AWS EC2 + PM2

PM2 manages the Node.js process, restarts it on crash, and starts it on reboot.

### 1. Launch EC2 Instance

- **AMI:** Ubuntu 24.04 LTS
- **Instance type:** `t3.medium` minimum (avatar rendering is CPU-light; bottleneck is Azure API calls)
- **Storage:** 30 GB gp3 (generated videos are stored locally in `artifacts/api-server/outputs/`)
- **Security group inbound rules:**
  - Port 22 (SSH)
  - Port 80 (HTTP)
  - Port 443 (HTTPS — if using Nginx + SSL)

### 2. Server Setup

```bash
# Connect to EC2
ssh -i your-key.pem ubuntu@YOUR_EC2_IP

# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install pnpm
sudo npm install -g pnpm@9

# Install PM2
sudo npm install -g pm2

# Verify
node --version   # v20.x.x
pnpm --version   # 9.x.x
pm2 --version
```

### 3. Deploy the Application

```bash
# Clone repository
git clone https://github.com/your-org/learnbay-video-generator.git
cd learnbay-video-generator

# Install dependencies
pnpm install --frozen-lockfile

# Create .env from example
cp .env.example .env
nano .env   # Fill in all Azure credentials
```

### 4. Build for Production

```bash
# Build frontend
PORT=24396 BASE_PATH=/ pnpm --filter @workspace/video-generator run build

# Build API server
pnpm --filter @workspace/api-server run build
```

### 5. Start with PM2

The `ecosystem.config.cjs` file at the project root configures PM2:

```bash
pm2 start ecosystem.config.cjs
pm2 save                    # persist across reboots
pm2 startup                 # generate systemd startup script (follow printed instructions)
```

Useful PM2 commands:

```bash
pm2 status                  # view all processes
pm2 logs learnbay-api   # tail logs
pm2 reload learnbay-api # zero-downtime restart
pm2 restart learnbay-api
pm2 stop learnbay-api
```

### 6. Nginx Reverse Proxy (Recommended)

```bash
sudo apt-get install -y nginx

sudo tee /etc/nginx/sites-available/learnbay <<'EOF'
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 60s;
        proxy_send_timeout 300s;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/learnbay /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

#### Add SSL with Certbot

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### 7. Deploy Updates

```bash
cd learnbay-video-generator
git pull origin main
pnpm install --frozen-lockfile
PORT=24396 BASE_PATH=/ pnpm --filter @workspace/video-generator run build
pnpm --filter @workspace/api-server run build
pm2 reload learnbay-api
```

---

## Option C: AWS Docker

### Dockerfile Overview

The project ships with a multi-stage `Dockerfile` at the project root.  
A `docker-compose.yml` is also provided for single-host deployments.

### 1. Build the Docker Image

```bash
# Build image (from project root)
docker build -t learnbay-video-generator:latest .

# Or with a version tag
docker build -t learnbay-video-generator:1.0.0 .
```

### 2. Run Locally with Docker Compose

```bash
# Copy and edit environment file
cp .env.example .env
# Edit .env with your credentials

docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

App will be available at `http://localhost:8080`.

### 3. Deploy to AWS ECS (Fargate)

#### Push image to ECR

```bash
# Authenticate Docker to ECR
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin \
    YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com

# Create ECR repository (once)
aws ecr create-repository --repository-name learnbay-video-generator

# Tag and push
docker tag learnbay-video-generator:latest \
  YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/learnbay-video-generator:latest

docker push \
  YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/learnbay-video-generator:latest
```

#### ECS Task Definition (key settings)

| Setting | Value |
|---------|-------|
| Launch type | Fargate |
| CPU | 1024 (1 vCPU) |
| Memory | 2048 MB |
| Container port | 8080 |
| Environment | All `.env` variables added as ECS secrets/env vars |
| Storage | Mount an EFS volume to `/app/artifacts/api-server/outputs` for persistent video storage |

> Add all environment variables from the [reference table above](#environment-variables-reference) as ECS Task Definition environment variables or AWS Secrets Manager secrets.

#### EFS for Persistent Video Storage

Generated videos are written to `artifacts/api-server/outputs/`. Without persistent storage, videos are lost when the container restarts. Mount an EFS volume:

```bash
# Create EFS
aws efs create-file-system --region us-east-1

# In ECS task definition, add a volume:
# Name: video-outputs
# EFS file system ID: fs-XXXXXXXXX
# Container mount point: /app/artifacts/api-server/outputs
```

### 4. Deploy to EC2 with Docker (simpler than ECS)

```bash
# SSH into EC2
ssh -i your-key.pem ubuntu@YOUR_EC2_IP

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu

# Pull image from ECR
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin \
    YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com

docker pull YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/learnbay-video-generator:latest

# Run
docker run -d \
  --name learnbay \
  --restart unless-stopped \
  -p 8080:8080 \
  --env-file /home/ubuntu/learnbay.env \
  -v /mnt/videos:/app/artifacts/api-server/outputs \
  YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/learnbay-video-generator:latest
```

---

## Persistent Video Storage

Generated videos are saved to `artifacts/api-server/outputs/`. Make sure this is a persistent volume in any deployment:

| Option | Persistence |
|--------|-------------|
| Local | Persists automatically |
| PM2 on EC2 | Persists on disk; add to backup routine |
| Docker on EC2 | Mount `-v /host/path:/app/artifacts/api-server/outputs` |
| ECS Fargate | Mount EFS volume to `/app/artifacts/api-server/outputs` |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `PORT environment variable is required` | Set `PORT=8080` before starting the server |
| `BASE_PATH environment variable is required` | Set `BASE_PATH=/` for the Vite build step |
| Avatar synthesis timeout | Azure batch avatar jobs can take 3–8 min; increase Nginx `proxy_read_timeout` to `600s` |
| Avatar region error | Speech resource must be in `westus2`, `westeurope`, or `southeastasia` |
| Videos lost after restart | Mount a persistent volume to `artifacts/api-server/outputs/` |
| ElevenLabs audio fails | Set `PUBLIC_URL=https://your-domain.com` — it must be publicly accessible for Azure to fetch the audio |
| `gpt-image-1` 404 | Ensure you've deployed a `gpt-image-1` model in your Azure OpenAI resource with that exact deployment name |
