@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules" (
  echo 正在安装依赖，请稍候...
  call npm.cmd install
)

echo.
echo 正在启动房间服务器和开发服务器...
start "kart-room" cmd /c "npm.cmd run server"
start "kart-dev" cmd /c "npm.cmd run dev"
timeout /t 5 /nobreak >nul
start "" http://localhost:5173/

echo.
echo 浏览器已打开。关闭那两个黑色命令行窗口即可停止游戏。
pause
