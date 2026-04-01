module.exports = {
  apps: [
    {
      name: 'galana-scheduler',
      script: 'src/report/schedule-report.js',
      cwd: '/home/kamsu-perold/shortest-path-way-app',
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        TZ: 'UTC'
      },
      log_file: 'logs/scheduler.log',
      error_file: 'logs/scheduler-error.log',
      time: true
    }
  ]
};
