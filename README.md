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

## VCR Deployment
View the [deploying guide](https://developer.vonage.com/vcr/guides/deploying) to learn more about deploying on Vonage Cloud Runtime.# multiple-redirect-demo
