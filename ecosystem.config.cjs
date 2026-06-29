module.exports = {
  apps: [
    {
      name: "kimi-proxy",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/index.ts",
      cwd: "/root/kimi-proxy",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
      out_file: "/root/kimi-proxy/logs/pm2-out.log",
      error_file: "/root/kimi-proxy/logs/pm2-err.log",
      merge_logs: true,
      time: true,
    },
    {
      // OpenAI-only 上游的转协议 sidecar。装在项目内 venv(见 litellm/setup.sh),
      // 配置与密钥都在 litellm/config.yaml(由项目根相对路径引用,故 cwd=项目根)。
      // 若不需要任何 OpenAI 协议上游,可删掉本块或 `pm2 delete litellm`。
      name: "litellm",
      script: "litellm/.venv/bin/litellm",
      args: "--config litellm/config.yaml --port 4000 --host 127.0.0.1",
      cwd: "/root/kimi-proxy",
      interpreter: "none", // venv 里的 litellm 自带 shebang,直接执行,别用 node 跑
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
      },
      out_file: "/root/kimi-proxy/logs/pm2-litellm-out.log",
      error_file: "/root/kimi-proxy/logs/pm2-litellm-err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
