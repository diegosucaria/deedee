# Aerolineas Argentinas Checkout Guide

## Passenger Details
When filling out passenger forms, use `browser_snapshot` to get refs first, then `browser_fill_form` to batch fill all fields. Ensure:
*   **DNI**: Use the "Document Type" dropdown to select "DNI" before typing the number.
*   **Names**: Enter names EXACTLY as they appear on the ID, without accents if potential encoding issues arise (though modern forms should handle UTF-8).
*   **Email**: Double-check the email field; this is where tickets are sent.

## Payment
*   **Billing Address**: If required, use the address associated with the Credit Card.

## Troubleshooting
*   **Popups**: The site frequently shows "Subscribe" or "Offer" popups. Use the `Escape` key or look for the "X" (close) button immediately upon page load.
*   **Session Timeout**: The session lasts about 15 minutes. If it expires, restart the search from `aerolineas.com.ar`.
*   **Date Format**: Use `DD/MM/YYYY` format for dates.
*   **Airport Selector**: Use the airport code (e.g. `EZE` for Ezeiza) in the airport selector and always click on the name to select it. Otherwise, the form will not submit.

