module.exports = {
  apps: [
    {
      name: 'stream-router',
      script: './apps/api/dist/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      // Hanya pengaman kebocoran memori. Restart PM2 memutus relay online dan bridge MQTT;
      // MediaMTX tetap meng-ingest dan merekam, tetapi tanpa retention, storage guard, dan
      // indeks segment sampai API kembali. Batas ini harus jauh di atas working set normal
      // (maintenance recording pada 100 kamera), bukan batas operasional.
      max_memory_restart: '1G',
      kill_timeout: 15000,
      listen_timeout: 10000,
      env_production: {
        NODE_ENV: 'production'
      },
      out_file: './data/app-out.log',
      error_file: './data/app-error.log',
      merge_logs: true,
      time: true
    }
  ]
};
