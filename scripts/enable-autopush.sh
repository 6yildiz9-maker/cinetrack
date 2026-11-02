#!/bin/bash
# CineTrack — post-commit otomatik push kancası kurulumu
# Kullanım (Git Bash içinde): bash scripts/enable-autopush.sh
# Not: .git/hooks sürümlenmediği için yeni bir klonda bu scripti tekrar çalıştırın.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/.git/hooks/post-commit"
mkdir -p "$ROOT/.git/hooks"
cat > "$HOOK" <<'EOF'
#!/bin/sh
# CineTrack otomatik push kancası (kurulum: scripts/enable-autopush.sh)
# Her commit sonrası geçerli dalı origin'e gönderir.
# Push başarısız olursa commit kaybolmaz; bir sonraki başarılı push
# bekleyen tüm commit'leri birlikte taşır.
branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo master)
echo "[post-commit] $branch -> origin/$branch push ediliyor..."
git push origin "$branch"
exit 0
EOF
chmod +x "$HOOK"
echo "Kuruldu: $HOOK"
