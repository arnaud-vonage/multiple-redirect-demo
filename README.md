## Disclaimer
This sample code is provided for reference only.
It is offered as-is, with no guarantee that it works correctly in your environment, is production-ready, or is secure.
You are responsible for validating, testing, and hardening it before any real-world use.

## Vonage Dashboard
Create a Vonage application and link the numbers to the app.
Under vcr.yml, for this part:
```
application-id: APPLICATION_ID
```
Change the value of `APPLICATION_ID` to the Vonage application id.

## Changing destination number
Update `number-mapping.csv` with source and destination pairs in E.164 format.
If an inbound number has no mapping, the app returns a fallback message and does not attempt to connect.

## Security configuration
Create the VCR secrets before deploying:

```sh
vcr secret create --name WEBHOOK_TOKEN --value YOUR_WEBHOOK_TOKEN
vcr secret create --name ADMIN_API_KEY --value YOUR_ADMIN_API_KEY
```

Then reference them under `environment` in `vcr.yml`:

```
- name: WEBHOOK_TOKEN
  secret: WEBHOOK_TOKEN
- name: ADMIN_API_KEY
  secret: ADMIN_API_KEY
- name: ENABLE_DEBUG_ROUTES
  value: "false"
```

`WEBHOOK_TOKEN` is appended to the registered Vonage webhook URLs and is required by `/answer` and `/event`.
`ADMIN_API_KEY` is required to access `/_/mappings` and any enabled `/_/debug/*` route using either the `x-admin-api-key` header or `Authorization: Bearer ...`.
Leave `ENABLE_DEBUG_ROUTES` set to `false` in deployed environments unless you explicitly need the debug endpoints.
For local `vcr debug`, export development values in your shell or source a local `.env` file before starting the debugger.

## VCR Deployment
View the [deploying guide](https://developer.vonage.com/vcr/guides/deploying) to learn more about deploying on Vonage Cloud Runtime.# multiple-redirect-demo

## License
This project is licensed under the MIT License. See the LICENSE file for details.
