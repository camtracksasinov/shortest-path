# Email Route Plans to Transporters

This module sends optimized route plans to transporters via email after the Excel file has been updated with the optimal order.

## Setup

### 1. Configure Email Settings in .env

```env
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_FROM=your-email@gmail.com
```

### 2. Gmail App Password Setup (if using Gmail)

1. Go to Google Account settings
2. Enable 2-Factor Authentication
3. Generate an App Password for "Mail"
4. Use the generated password in EMAIL_PASSWORD

## Usage

### Send emails after updating Excel:

```bash
npm run send-emails
```

### Or run the complete workflow (includes email sending):

```bash
node run-all.js
```

## Email Template

The email includes:
- **Transporteur**: Company name
- **Véhicule**: Vehicle ID
- **Date**: Delivery date
- **Chauffeur**: Driver name
- **Dépôt de départ**: Starting depot
- **Heure D'arrivée Dépôt**: Arrival time at depot

### Route Table:
- **Ordre**: Sequential order (from shortest path calculation)
- **Point de livraison**: Delivery location name
- **Ville**: City
- **Essence (L) / Gasoil (m³)**: GO column value
- **Pétrole lampant (L) / Essence SP95 (m³)**: SC column value
- **Total (L) / Pétrole lampant (m³)**: PL column value
- **Total (m³)**: Sum of GO + SC + PL

## Product Codes

- **GO**: Gasoil (m³)
- **SC**: Essence SP95 (m³)
- **PL**: Pétrole lampant (m³)
- **FO**: Fioul (m³)

## Testing

For testing, the first vehicle's route plan is sent to: `ulrich.kamsu@camtract.net`

To enable sending to all transporters, edit `send-route-emails.js` and uncomment the loop at the end of the `processExcelAndSendEmails` function.

## How It Works

1. Reads the latest `*_updated-with-order.xlsx` file from downloads/
2. Groups delivery points by vehicle (Transporteur + Véhicule)
3. Extracts route information including trajectory order
4. Generates HTML email with formatted route table
5. Sends email to transporter's email address (from "Email Transp" column)

## Notes

- Only delivery points with trajectory numbers are included (parking locations excluded)
- Emails are sent sequentially with 1-second delay to avoid rate limiting
- The script currently sends only to the first vehicle for testing purposes
