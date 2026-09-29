/**
 * PM2 Ecosystem File — Learnbay Video Generator
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup
 */

module.exports = {
  apps: [
    {
      name: "learnbay-api",
      script: "./artifacts/api-server/dist/index.mjs",
      interpreter: "node",
      interpreter_args: "--enable-source-maps",

      // Environment
      env: {
        NODE_ENV: "production",
        PORT: 8080,

        // Azure Speech
        AZURE_SPEECH_KEY: process.env.AZURE_SPEECH_KEY,
        AZURE_SPEECH_REGION: process.env.AZURE_SPEECH_REGION,

        // Azure OpenAI (text)
        AZURE_OPENAI_API_KEY: process.env.AZURE_OPENAI_API_KEY,
        AZURE_OPENAI_ENDPOINT: process.env.AZURE_OPENAI_ENDPOINT,
        AZURE_OPENAI_DEPLOYMENT: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o-mini",

        // Azure OpenAI (image)
        AZURE_IMAGE_API_KEY: process.env.AZURE_IMAGE_API_KEY,
        AZURE_IMAGE_ENDPOINT: process.env.AZURE_IMAGE_ENDPOINT,
        AZURE_IMAGE_DEPLOYMENT: process.env.AZURE_IMAGE_DEPLOYMENT || "gpt-image-1",

        // App
        PUBLIC_URL: process.env.PUBLIC_URL,
        ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
        PEXELS_API_KEY: process.env.PEXELS_API_KEY,
        FFMPEG_PATH: process.env.FFMPEG_PATH,
        LOG_LEVEL: process.env.LOG_LEVEL,
      },

      // Process management
      instances: 1,           // single instance — avatar jobs are I/O bound, not CPU
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",

      // Logging
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      merge_logs: true,

      // Graceful shutdown — give avatar jobs time to complete in-flight requests
      kill_timeout: 10000,
    },
  ],
};
