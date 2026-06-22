## Vonage Dashboard
Create a Vonage application and link the numbers to the app.
Under vcr.yml, for this part:
```
application-id: APPLICATION_ID
```
Change the value of `APPLICATION_ID` to the Vonage application id.

## Changing destination number
Under vcr.yml, for this part:
```
environment:
    - name: DEST_NUMBER
        value: 00000000
```
Change the value of `00000000` to the destination number.

## VCR Deployment
View the [deploying guide](https://developer.vonage.com/vcr/guides/deploying) to learn more about deploying on Vonage Cloud Runtime.# multiple-redirect-demo
