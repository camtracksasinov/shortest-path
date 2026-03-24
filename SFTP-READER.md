# SFTP Excel Reader

Connects to an SFTP server, downloads Excel files from the IN folder, and extracts "Coordonnees Zone" column values.

## Setup

### 1. Install Dependencies
```bash
npm install ssh2-sftp-client xlsx
```

### 2. Configure SFTP Credentials

Create a `.env` file:
```bash
cp .env.example .env
```

Edit `.env` with your SFTP credentials:
```env
SFTP_HOST=your-server-host.com
SFTP_PORT=22
SFTP_USERNAME=your-username
SFTP_PASSWORD=your-password
SFTP_REMOTE_PATH=/IN
```

### 3. Load Environment Variables (Optional)

Install dotenv:
```bash
npm install dotenv
```

Or set environment variables manually:
```bash
export SFTP_HOST=your-server-host.com
export SFTP_USERNAME=your-username
export SFTP_PASSWORD=your-password
```

## Usage

### Test with Local File First
```bash
npm run sftp -- --local
```

### Connect to SFTP Server
```bash
npm run sftp
```

Or with environment variables:
```bash
SFTP_HOST=server.com SFTP_USERNAME=user SFTP_PASSWORD=pass npm run sftp
```

## What It Does

1. ✅ Connects to SFTP server
2. ✅ Lists files in `/IN` folder
3. ✅ Downloads Excel files (*.xlsx)
4. ✅ Parses Excel file
5. ✅ Finds "Coordonnees Zone" column
6. ✅ Extracts all values
7. ✅ Displays in terminal
8. ✅ Saves to `downloads/coordinates.json`

## Output Example

```
🔌 Connecting to SFTP server...
✅ Connected successfully!

📂 Listing files in /IN...
📊 Found 1 Excel file(s):
   1. Livraison 11-12-2025 - test.xlsx (16.5 KB)

⬇️  Downloading: Livraison 11-12-2025 - test.xlsx...
✅ Downloaded to: ./downloads/Livraison 11-12-2025 - test.xlsx

📖 Reading Excel file...
✅ Found column "Coordonnees Zone" at index 5

======================================================================
📍 COORDONNEES ZONE VALUES:
======================================================================

1. 4.0994299994479295, 9.7367190224495
2. 4.099579818838753, 9.746568093470469
3. 4.085881930020306, 9.734573255342536
...

======================================================================
📊 Total: 15 coordinate entries found
======================================================================

💾 Coordinates saved to: ./downloads/coordinates.json
```

## Troubleshooting

### Connection Issues
- Check host, port, username, password
- Verify firewall allows SFTP (port 22)
- Test connection with FileZilla first

### Authentication Issues
- Verify credentials
- Try private key authentication instead

### File Not Found
- Check remote path is correct (`/IN`)
- Verify Excel file exists in IN folder
- Check file permissions

## Private Key Authentication

If using SSH key instead of password:

```javascript
// In sftp-excel-reader.js, uncomment:
privateKey: fs.readFileSync('/path/to/private/key')
// And remove password line
```

Or set environment variable:
```bash
export SFTP_PRIVATE_KEY_PATH=/path/to/key
```
