@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js bulunamadi. Once https://nodejs.org adresinden Node.js yukleyin.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm bulunamadi. Node.js kurulumunuzu kontrol edin.
  pause
  exit /b 1
)

if not exist "node_modules\tsx\dist\cli.mjs" (
  echo Gerekli paketler yukleniyor...
  call npm install
  if errorlevel 1 (
    echo Paketler yuklenemedi. Internet baglantinizi ve npm kurulumunuzu kontrol edin.
    pause
    exit /b 1
  )
)

echo CineTrack baslatiliyor. Tarayicida http://127.0.0.1:3000 adresini acin.
echo Sunucuyu durdurmak icin bu pencerede Ctrl+C tuslarina basin.
call npm run dev
pause
