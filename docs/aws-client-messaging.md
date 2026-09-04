# AWS client messaging setup

The Client SMS workspace creates a site-scoped, consent-audited campaign in PostgreSQL, places one delivery job per client in Amazon SQS, and sends it from a separate worker through AWS End User Messaging SMS.

`SENT` in the database means AWS accepted the API request. It is not a handset delivery or read receipt. Add an SMS event destination later if those states are required.

## 1. Apply the database migration

From `rgaccountbackend`:

```bash
npm install
npm run migrate:client-messaging
```

The normal `npm start` and `npm run migrate` chains also apply this migration.

## 2. Choose the AWS account and region

1. Sign in to the AWS account that will own the messaging resources.
2. For an India deployment, use `ap-south-1` (Mumbai) for SQS and SMS unless your existing architecture requires otherwise.
3. For local development, configure an AWS CLI profile or IAM Identity Center session and verify it with `aws sts get-caller-identity`.
4. In production, attach an IAM role to the API and worker runtime. Do not store long-lived AWS access keys in the repository.

## 3. Create the SQS queue

In the same AWS account and region as the API:

1. Create a **Standard** queue, for example `client-messages`.
2. Create a second Standard queue, for example `client-messages-dlq`.
3. On the main queue, configure a redrive policy to the DLQ with `maxReceiveCount` of `5`.
4. Set receive-message wait time to `20` seconds and visibility timeout to at least `60` seconds. Increase the visibility timeout if a provider call can take longer in your environment.
5. Copy the main queue URL to `AWS_CLIENT_MESSAGE_QUEUE_URL`.

The API must be able to call `sqs:SendMessage`. The worker needs `sqs:ReceiveMessage` and `sqs:DeleteMessage` for the main queue.

## 4. Give the app an IAM role

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
        "sms-voice:SendTextMessage"
      ],
      "Resource": "*"
    }
  ]
}
```

For production, split the API and worker roles: the API only needs `sqs:SendMessage`; the worker needs receive/delete plus `sms-voice:SendTextMessage`. Tighten access using the resource ARNs supported in your selected region.

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

## 6. Start the API and worker

Set the variables from `.env.example`, then run the web API and a persistent worker as separate processes:

```bash
npm start
npm run worker:client-messages
```

In production, supervise the worker with the same platform used for the API (for example, a separate ECS service or process unit) and configure restarts, logs, alarms, and DLQ alerts.

## 7. Grant application permission and test safely

1. As an administrator, open **Module Permissions**.
2. Grant the intended sub-admin **View** on Management Analytics and **Create** on Client SMS.
3. Open **Management Analytics → Client SMS**.
4. Send a one-recipient transactional test to a phone number you own and have opted in.
5. Confirm the campaign moves from `QUEUED`/`SENDING` to `COMPLETED`, and inspect worker logs and the AWS console if it fails.
6. Test missing mobile numbers, duplicate destinations, SMS opt-out handling, provider rejection, and DLQ alarms before enabling bulk sends.

Never store opt-in as only a checkbox click. Keep the underlying consent evidence and channel-specific unsubscribe/opt-out workflow in your system of record.

## AWS references

- [Amazon SQS visibility timeouts and DLQ guidance](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [AWS End User Messaging SMS `SendTextMessage`](https://docs.aws.amazon.com/pinpoint/latest/apireference_smsvoicev2/API_SendTextMessage.html)
- [India local-route and DLT requirements](https://docs.aws.amazon.com/sms-voice/latest/userguide/registrations-sms-senderid-india-routes.html)
