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
  ],
};
