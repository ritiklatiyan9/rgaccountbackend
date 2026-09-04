# AWS client messaging setup

The Client Messages workspace creates a site-scoped, consent-audited campaign in PostgreSQL, places one delivery job per client/channel in Amazon SQS, and sends it from a separate worker through Amazon SES, AWS End User Messaging SMS, or AWS End User Messaging Social (WhatsApp).

`SENT` in the database means AWS accepted the API request. It is not a handset, inbox, read, or click receipt. Add provider event destinations later if those states are required.

## 1. Apply the database migration

From `rgaccountbackend`:

```bash
npm install
npm run migrate:client-messaging
```

The normal `npm start` and `npm run migrate` chains also apply this migration.

## 2. Create the SQS queue

In the same AWS account and region as the API:

1. Create a **Standard** queue, for example `client-messages`.
2. Create a second Standard queue, for example `client-messages-dlq`.
3. On the main queue, configure a redrive policy to the DLQ with `maxReceiveCount` of `5`.
4. Set receive-message wait time to `20` seconds and visibility timeout to at least `60` seconds. Increase the visibility timeout if a provider call can take longer in your environment.
5. Copy the main queue URL to `AWS_CLIENT_MESSAGE_QUEUE_URL`.

The API must be able to call `sqs:SendMessage`. The worker needs `sqs:ReceiveMessage` and `sqs:DeleteMessage` for the main queue.

## 3. Give the app an IAM role

Attach an IAM role to the ECS task, EC2 instance, Lambda-compatible runtime, or other workload that runs the API and worker. The AWS SDK uses the default credential provider chain, so production does not need access keys in `.env`.

The combined role needs these actions, scoped to the relevant resources wherever AWS supports resource-level permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ClientMessageQueue",
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage"
      ],
      "Resource": "arn:aws:sqs:REGION:ACCOUNT_ID:client-messages"
    },
    {
      "Sid": "ClientMessageProviders",
      "Effect": "Allow",
      "Action": [
        "ses:SendEmail",
        "sms-voice:SendTextMessage",
        "social-messaging:SendWhatsAppMessage"
      ],
      "Resource": "*"
    }
  ]
}
```

For production, split the API and worker roles: the API only needs `sqs:SendMessage`; the worker needs receive/delete plus the provider actions. Restrict SES to the verified identity and tighten other resources using the ARNs supported in the regions you selected.

## 4. Configure Amazon SES email

1. In Amazon SES, verify the sending domain or email identity and enable DKIM for a domain.
2. If the account is in the SES sandbox, request production access. In the sandbox, recipients also have to be verified.
3. Optionally create a configuration set for delivery/bounce events.
4. Set:

```dotenv
AWS_SES_REGION=ap-south-1
AWS_SES_FROM_EMAIL=updates@your-domain.example
AWS_SES_CONFIGURATION_SET=
```

## 5. Configure AWS End User Messaging SMS

1. Open AWS End User Messaging SMS in the target region.
2. Request/register an origination identity appropriate for each destination country, complete sender registration, leave the SMS sandbox, and confirm the account spend threshold.
3. Create a protect configuration and allow only the destination countries the business uses.
4. Set:

```dotenv
AWS_SMS_REGION=ap-south-1
AWS_SMS_ORIGINATION_IDENTITY=YOUR_PHONE_NUMBER_OR_SENDER_ID_OR_POOL_ID
AWS_SMS_CONFIGURATION_SET=
AWS_SMS_PROTECT_CONFIGURATION_ID=
```

For India local routes, complete TRAI/DLT registration and use an AWS-supported India region. The entity ID, template ID, sender/header, message text, and variable placement must match the registered DLT template exactly:

```dotenv
AWS_SMS_ENTITY_ID=YOUR_DLT_ENTITY_ID
AWS_SMS_TEMPLATE_ID=YOUR_DLT_TEMPLATE_ID
```

The UI accepts custom text, but India SMS text still has to comply with the selected registered DLT template. Use the **Promotional** category only for properly consented marketing traffic.

## 6. Configure WhatsApp through AWS End User Messaging Social

1. In AWS End User Messaging Social, link or create a Meta WhatsApp Business Account and register an origination phone number.
2. Complete Meta business/phone verification and move the number to production.
3. Obtain explicit WhatsApp opt-in from recipients.
4. Create and obtain approval for a template such as `client_site_update`. This implementation expects one body text variable; the composed custom message is passed as that variable.
5. Copy the origination phone-number ID and choose a Meta API version currently supported by AWS/Meta.
6. Set:

```dotenv
AWS_WHATSAPP_REGION=YOUR_SUPPORTED_SOCIAL_MESSAGING_REGION
AWS_WHATSAPP_PHONE_NUMBER_ID=YOUR_ORIGINATION_PHONE_NUMBER_ID
AWS_WHATSAPP_TEMPLATE_NAME=client_site_update
AWS_WHATSAPP_TEMPLATE_LANGUAGE=en_US
AWS_WHATSAPP_META_API_VERSION=vXX.X
```

This worker deliberately sends approved templates. Free-form WhatsApp messages are subject to the 24-hour customer-service window and are not used by this campaign flow.

## 7. Start the API and worker

Set the variables from `.env.example`, then run the web API and a persistent worker as separate processes:

```bash
npm start
npm run worker:client-messages
```

In production, supervise the worker with the same platform used for the API (for example, a separate ECS service or process unit) and configure restarts, logs, alarms, and DLQ alerts.

## 8. Grant application permission and test safely

1. As an administrator, open **Module Permissions**.
2. Grant the intended sub-admin **View** on Management Analytics and **Create** on Client Messaging.
3. Open **Management Analytics → Client Messages**.
4. Send a one-recipient transactional test to an email address/phone number you own and have opted in.
5. Confirm the campaign moves from `QUEUED`/`SENDING` to `COMPLETED`, and inspect worker logs and the AWS console if it fails.
6. Test missing contact data, duplicate destinations, SES bounces, SMS opt-out handling, WhatsApp template rejection, and DLQ alarms before enabling bulk sends.

Never store opt-in as only a checkbox click. Keep the underlying consent evidence and channel-specific unsubscribe/opt-out workflow in your system of record.

## AWS references

- [Amazon SQS visibility timeouts and DLQ guidance](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [Amazon SES verified identities and sandbox rules](https://docs.aws.amazon.com/ses/latest/dg/verify-addresses-and-domains.html)
- [AWS End User Messaging SMS `SendTextMessage`](https://docs.aws.amazon.com/pinpoint/latest/apireference_smsvoicev2/API_SendTextMessage.html)
- [India local-route and DLT requirements](https://docs.aws.amazon.com/sms-voice/latest/userguide/registrations-sms-senderid-india-routes.html)
- [WhatsApp sending, opt-in, templates, and the 24-hour service window](https://docs.aws.amazon.com/social-messaging/latest/userguide/whatsapp-send-message.html)
- [AWS Social Messaging `SendWhatsAppMessage`](https://docs.aws.amazon.com/social-messaging/latest/APIReference/API_SendWhatsAppMessage.html)
