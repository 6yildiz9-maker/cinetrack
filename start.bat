@echo off
cd /d "%~dp0"
if not exist ".env.local" (
  copy ".env.example" ".env.local" >nul
  echo .env.local ayar dosyasi olusturuldu.
  echo Bu dosyayi acip TMDB_API_KEY alanina kendi anahtarinizi ekleyin, sonra start.bat'i yeniden calistirin.
  pause
  exit /b 1
)
findstr /R /C:"^[ ]*TMDB_API_KEY=[^ ]" ".env.local" >nul
if errorlevel 1 (
  echo .env.local icindeki TMDB_API_KEY alani bos.
  echo Anahtari bu dosyaya ekleyip start.bat'i yeniden calistirin. HTML icine yazmayin.
  pause
  exit /b 1
)
start "CineTrack local TMDB proxy" /min node server.mjs
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4173"
