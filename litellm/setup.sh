#!/usr/bin/env bash
# 在项目内创建独立 venv 并安装钉死版本的 LiteLLM。
# 幂等:重复跑只会升级/补齐依赖。升级版本改 requirements.txt 后重跑本脚本即可。
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"

if [ ! -d .venv ]; then
  "$PY" -m venv .venv
fi

./.venv/bin/pip install --upgrade pip >/dev/null
./.venv/bin/pip install -r requirements.txt

echo
echo "✓ LiteLLM 已安装到 litellm/.venv"
echo "  下一步:"
echo "  1) cp litellm/config.example.yaml litellm/config.yaml,填 model_list 与各后端 key、master_key"
echo "  2) pm2 start ecosystem.config.cjs   # 同时拉起 kimi-proxy 与 litellm"
echo "     或单独验证:  ./.venv/bin/litellm --config config.yaml --port 4000"
