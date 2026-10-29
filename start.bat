@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js bulunamadi. Once https://nodejs.org adresinden Node.js 22.18 veya uzeri surumu yukleyin.
  pause
  exit /b 1
)

node -e "const [maj,min]=process.versions.node.split('.').map(Number);process.exit(maj>22||(maj===22&&min>=18)?0:1)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.18.0 veya uzeri surum gereklidir. Lutfen https://nodejs.org adresinden guncelleyin.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm bulunamadi. Node.js kurulumunuzu kontrol edin.
  pause
  exit /b 1
)

if not exist "node_modules\express\index.js" (
  echo Gerekli paketler yukleniyor...
  call npm install
  if errorlevel 1 (
    echo Paketler yuklenemedi. Internet baglantinizi ve npm kurulumunuzu kontrol edin.
    pause
    exit /b 1
  )
)

if not exist "dist\index.html" (
  echo Uretim derlemesi hazirlaniyor...
  call npm run build
  if errorlevel 1 (
    echo Derleme basarisiz oldu.
    pause
    exit /b 1
  )
)

set NODE_ENV=production
echo CineTrack uretim modunda baslatiliyor. Tarayicida http://127.0.0.1:3000 adresini acin.
echo Sunucuyu durdurmak icin bu pencerede Ctrl+C tuslarina basin.
call npm start
pause
