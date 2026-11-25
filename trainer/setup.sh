#!/usr/bin/env bash
# Sets up a computer at home (Ubuntu Server 24.04) as the trainer of the plant-disease model:
# Python with PyTorch (CPU), a GitHub Actions runner for this repository as a service, a folder
# that keeps the photos between trainings, and Wake-on-LAN, so Home Assistant can wake it and
# the training can switch it off again (variable TRAINER_SHUTDOWN). Steps: ml/trainer/README.md
# in the app's repository.
#
# Run it as your normal user (with sudo rights), not as root:
#   curl -fsSL https://raw.githubusercontent.com/basdelouw78/tm-db/main/trainer/setup.sh -o setup.sh
#   bash setup.sh
# It asks for a runner token: GitHub → the repository → Settings → Actions → Runners →
# New self-hosted runner (Linux, x64) → the token in the "Configure" step (valid for an hour).
# Running it again is safe: what is there already is kept.
set -euo pipefail

REPO="${REPO:-basdelouw78/tuinmaatje}"
RUNNER_VERSION="${RUNNER_VERSION:-2.338.2}"   # the runner updates itself afterwards
TRAINER=/srv/tuinmaatje
RUNNER_DIR="$HOME/actions-runner"

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as your normal user (with sudo), not as root." >&2
  exit 1
fi

echo "== Packages"
sudo apt-get update -q
sudo apt-get install -y -q git curl jq ethtool gh ca-certificates python3-venv python3-pip libarchive-tools

echo "== Swap: a safety net on a computer with little memory (4 GB)"
MEM_MB="$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)"
SWAP_MB="$(awk '/SwapTotal/ {print int($2 / 1024)}' /proc/meminfo)"
if [ "$MEM_MB" -lt 7000 ] && [ "$SWAP_MB" -lt 3500 ] && [ ! -f /swapfile-tuinmaatje ]; then
  sudo fallocate -l 4G /swapfile-tuinmaatje
  sudo chmod 600 /swapfile-tuinmaatje
  sudo mkswap /swapfile-tuinmaatje > /dev/null
  sudo swapon /swapfile-tuinmaatje
  echo "/swapfile-tuinmaatje none swap sw 0 0" | sudo tee -a /etc/fstab > /dev/null
fi
free -h

echo "== Python with PyTorch (CPU) in $TRAINER/venv"
sudo mkdir -p "$TRAINER/data"
sudo chown -R "$USER:" "$TRAINER"
[ -x "$TRAINER/venv/bin/python" ] || python3 -m venv "$TRAINER/venv"
"$TRAINER/venv/bin/pip" install -q --upgrade pip
"$TRAINER/venv/bin/pip" install -q --index-url https://download.pytorch.org/whl/cpu torch torchvision
"$TRAINER/venv/bin/pip" install -q onnx onnxruntime pillow numpy datasets
"$TRAINER/venv/bin/python" -c "import torch; print('PyTorch', torch.__version__, '- threads:', torch.get_num_threads())"

echo "== GitHub Actions runner in $RUNNER_DIR"
mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"
if [ ! -x ./config.sh ]; then
  curl -fsSL -o runner.tar.gz \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
  tar xzf runner.tar.gz
  rm runner.tar.gz
fi
sudo ./bin/installdependencies.sh > /dev/null
if [ ! -f .runner ]; then
  read -rsp "Runner token (GitHub → Settings → Actions → Runners → New self-hosted runner): " TOKEN
  echo
  # A token pasted from Windows can carry a carriage return or spaces, or be the whole
  # "./config.sh --url … --token …" line: keep only the token itself.
  TOKEN="$(printf '%s' "$TOKEN" | tr -d '\r')"
  case "$TOKEN" in *--token*) TOKEN="${TOKEN##*--token}" ;; esac
  TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
  if [ -z "$TOKEN" ]; then
    echo "No token given; run this script again with the token at hand." >&2
    exit 1
  fi
  ./config.sh --url "https://github.com/$REPO" --token "$TOKEN" --name "$(hostname)-trainer" \
    --labels tuinmaatje-trainer --work _work --unattended --replace
  unset TOKEN
fi
if [ ! -f .service ]; then
  sudo ./svc.sh install "$USER"
fi
sudo ./svc.sh start || true

echo "== Switching off after a training (only the shutdown command, nothing else)"
echo "$USER ALL=(root) NOPASSWD: /usr/sbin/shutdown" | sudo tee /etc/sudoers.d/tuinmaatje-shutdown > /dev/null
sudo chmod 440 /etc/sudoers.d/tuinmaatje-shutdown
sudo visudo -cf /etc/sudoers.d/tuinmaatje-shutdown > /dev/null

echo "== Wake-on-LAN"
IFACE="$(ip route show default | awk '{print $5; exit}')"
sudo tee /etc/systemd/system/wol@.service > /dev/null <<UNIT
[Unit]
Description=Wake-on-LAN for %i
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/ethtool -s %i wol g

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now "wol@${IFACE}.service" || echo "Wake-on-LAN could not be switched on for $IFACE"
MAC="$(cat "/sys/class/net/${IFACE}/address")"

cat <<DONE

Done. This computer is now the trainer "$(hostname)-trainer" for $REPO.

Next, in GitHub (the repository → Settings → Secrets and variables → Actions → Variables):
  TRAIN_RUNS_ON     ["self-hosted","tuinmaatje-trainer"]
  TRAINER_SHUTDOWN  true    (optional: switch off after a training)

For Home Assistant (Wake-on-LAN): network card $IFACE, MAC address $MAC.
In the BIOS of a Dell OptiPlex (F2 at start): Power Management → Wake on LAN: "LAN Only",
and Deep Sleep Control: "Disabled", or the computer cannot be woken when it is off.
DONE
