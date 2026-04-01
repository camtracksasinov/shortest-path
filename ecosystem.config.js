const path = require('path');

module.exports = {
  apps: [
    {
      name: 'galana-scheduler',
      script: path.join(__dirname, 'src/report/schedule-report.js'),
      cwd: __dirname,
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        TZ: 'UTC'
      },
      log_file: path.join(__dirname, 'logs/scheduler.log'),
      error_file: path.join(__dirname, 'logs/scheduler-error.log'),
      time: true
    }
  ]
};
