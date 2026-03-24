# Wialon Report Generator

This module generates detailed zone visit reports for vehicles using the Wialon API and the updated Excel file from the FTP server.

## Features

- Authenticates with Wialon API using token
- Retrieves resource and template IDs
- Fetches all vehicle IDs from Wialon
- Reads the updated Excel file with ordered zones
- Generates reports for each vehicle showing:
  - First entry time to each zone
  - Last exit time from each zone
  - Total duration spent in each zone
  - Visit status

## How It Works

### Step 1: Login
Authenticates with Wialon API and obtains a session ID.

**Endpoint:** `https://hst-api.wialon.com/wialon/ajax.html?svc=token/login`

### Step 2: Get Resource & Template IDs
Retrieves the resource ID (27616618) and template ID (13) for "Galana ressource".

**Endpoint:** `https://hst-api.wialon.com/wialon/ajax.html?svc=core/update_data_flags`

### Step 3: Get All Vehicles
Fetches all vehicle IDs and names from Wialon system.

**Endpoint:** `https://hst-api.wialon.com/wialon/ajax.html?svc=core/update_data_flags`

### Step 4: Read Updated Excel
Reads the updated Excel file (`Livraison 11-12-2025 - test-updated-with-order.xlsx`) to get:
- Vehicle names (Camion column)
- Ordered zones (Client/Depot column)
- Visit order (Order column)

### Step 5: Generate Reports
For each vehicle:
1. Executes the Wialon report using the vehicle ID
2. Retrieves zone visit data
3. Processes the data to find:
   - First entry to each zone
   - Last exit from each zone (excluding circular movements)
   - Duration = Last Exit - First Entry
4. Displays results in a formatted table

## Zone Visit Logic

The system intelligently determines the actual last exit from a zone:

- If the next row shows a different zone → Real exit (vehicle moved to another location)
- If the next row shows the same zone → Vehicle is still circling, continue searching for actual exit

## Usage

```bash
npm run report
```

## Output Format

```
================================================================================
🚛 VEHICLE: 2930 TBA
================================================================================
Order   Zone                              First Entry              Last Exit                Duration    Status
--------------------------------------------------------------------------------
1       STATION SAKAY NG PBF              2/18/2026, 11:03:34 PM   2/19/2026, 5:37:13 AM    6:33:39     Completed
2       STATION MIARINARIVO PBF           2/19/2026, 7:07:39 AM    2/19/2026, 7:18:29 AM    0:10:50     Completed
3       SMM PBF                           2/19/2026, 10:12:49 AM   2/19/2026, 10:13:15 AM   0:00:26     Completed
================================================================================
```

## Console Logging

Each step is logged to the console:
- ✅ Successful operations
- ⚠️  Warnings (vehicle not found, no data)
- ❌ Errors
- 🔄 Processing status

## Requirements

- Updated Excel file must exist in `downloads/` folder
- Valid Wialon API token
- Active internet connection
- Vehicle names in Excel must match Wialon system names

## Error Handling

- Handles missing vehicles gracefully
- Skips vehicles with no data
- Displays appropriate warnings
- Continues processing remaining vehicles on error
