#!/bin/bash
# Migration script to reorganize project structure

cd "$(dirname "$0")"

echo "📁 Reorganizing project structure..."

# Move routing files
mv calculate-routes.js src/routing/ 2>/dev/null
mv wialon-zones.js src/routing/ 2>/dev/null
mv update-excel-order.js src/routing/ 2>/dev/null

# Move report files
mv wialon-report.js src/report/ 2>/dev/null
mv schedule-report.js src/report/ 2>/dev/null
mv notify.js src/report/ 2>/dev/null

# Move email files
mv send-route-emails.js src/emails/ 2>/dev/null

# Move SFTP files
mv sftp-excel-reader.js src/sftp/ 2>/dev/null
mv upload-to-sftp.js src/sftp/ 2>/dev/null
mv check-sftp-files.js src/sftp/ 2>/dev/null

echo "✅ Files moved to new structure"
echo ""
echo "📝 Updating import paths in run-all.js and server.js..."

# Update run-all.js imports
sed -i "s|require('./wialon-zones')|require('./src/routing/wialon-zones')|g" run-all.js
sed -i "s|require('./calculate-routes')|require('./src/routing/calculate-routes')|g" run-all.js
sed -i "s|require('./update-excel-order')|require('./src/routing/update-excel-order')|g" run-all.js
sed -i "s|require('./send-route-emails')|require('./src/emails/send-route-emails')|g" run-all.js

# Update schedule-report.js imports
sed -i "s|require('./notify')|require('./notify')|g" src/report/schedule-report.js
sed -i "s|node wialon-report.js|node src/report/wialon-report.js|g" src/report/schedule-report.js

# Update all files to use correct downloads path
find src -name "*.js" -exec sed -i "s|'./downloads'|path.join(__dirname, '../../downloads')|g" {} \;
find src -name "*.js" -exec sed -i "s|\"./downloads\"|path.join(__dirname, '../../downloads')|g" {} \;

# Update wialon log path in server.js
sed -i "s|path.join(__dirname, 'downloads', 'wialon-notifications.txt')|path.join(__dirname, 'logs', 'wialon-notifications.txt')|g" server.js

echo "✅ Import paths updated"
echo ""
echo "🎉 Migration complete!"
echo ""
echo "New structure:"
echo "  src/routing/    - Route calculation & zone matching"
echo "  src/report/     - Wialon reports & scheduling"
echo "  src/emails/     - Email notifications"
echo "  src/sftp/       - SFTP operations"
echo "  downloads/      - Excel & JSON files"
echo "  logs/           - Wialon notification logs"
