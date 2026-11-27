import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // 允许临时内网穿透域名访问（cloudflared / pinggy / localtunnel）
    allowedHosts: ['.trycloudflare.com', '.pinggy.link', '.loca.lt', '.ngrok-free.app', '.bore.pub'],
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
});
