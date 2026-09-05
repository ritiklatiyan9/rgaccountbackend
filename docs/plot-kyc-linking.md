# Linking a KYC user to a plot

1. Open Plot Payments and select the plot, for example `/plot-payments/420` (Plot A12).
2. Beside the KYC status, click **Link KYC user** (or **Change link**).
3. Search by name, phone or user ID. Check the phone and father / husband details when several users have the same name. Use **Review selected user profile** if needed.
4. Select the correct person and click **Link selected user**.
5. The plot displays that user's KYC status. In Clients, the linked user's plot number opens that plot's payment page directly.

Users need Plot Payments update permission to change a link. Both records must belong to the same site. Register the person in that site through Clients first if they are missing.

The link identifies the existing buyer's KYC profile. It does not verify their KYC, change the recorded buyer name, transfer ownership, or alter payments, pricing or commissions. Complete or review KYC from the linked user's profile.

## Backend rollout

The local frontend is configured to use the hosted Render API. Deploy the backend changes before using the new action. The normal backend start command includes migration `149_plot_buyer_member`; for a deployment that runs `node src/server.js` directly, first run:

```sh
npm run migrate:plot-buyer-member
```

The migration adds a nullable member ID and index. It does not assign existing plots. Existing unambiguous name/booking matches continue to work. Explicit links take priority, and buyer pickers retain the selected member ID for future bookings.
