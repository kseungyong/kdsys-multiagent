module.exports = {
  apps: [{
    name: 'kdsys-multiagent',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    max_memory_restart: '512M',
    kill_timeout: 15000,
    env: {
      NODE_ENV: 'production',
      PORT: 3456,
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './data/logs/error.log',
    out_file: './data/logs/out.log',
    merge_logs: true,
  }],
};
