// ecosystem.config.js
module.exports = {
  apps: [{
    name:     'cbk-banking',
    script:   'server.js',
    instances: 'max',
    exec_mode: 'cluster',
    watch:    false,
    max_memory_restart: '500M',
    env: { NODE_ENV: 'production', PORT: 3000 },
    error_file:     'logs/pm2-error.log',
    out_file:       'logs/pm2-out.log',
    log_date_format:'YYYY-MM-DD HH:mm:ss',
    restart_delay:  5000,
    max_restarts:   10,
  }],
};
