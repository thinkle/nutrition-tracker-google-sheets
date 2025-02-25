# Nutrition Tracker Shim for Working w/ AI

If you have the paid ChatGPT you can make a custom GPT which you give access to an API. This project leverages that capability to let you track nutritional data in a google sheet. It turns GPT into a running nutritionist and health advisor, which is pretty awesome.

Most of the code here is for a spreadsheet-attached google-apps-script project which will (1) set up a spreadsheet for tracking daily nutritional data as well as goals and metrics (2) set up a google apps web-app end-point to act as an API for updating/reading/writing that data.

In practice, ChatGPT has a bit of trouble working directly with Google Apps Script for two reasons: (1) Apps Script requires you to follow redirects (2) Apps Script doesn't support full CRUD operations with HTML POST/GET/DELETE/UPDATE, etc (it only supports GET and POST).

Because of that, I created a Cloudflare worker to act as a go-between and present an API to ChatGPT that it will like.

If you hit the endpoint without any arguments, you will get the OpenAPI spec which ChatGPT likes -- a lot of this project was tweaking that spec to make GPT happy :)

In addition, I have added a XertOpenApiSpec which will allow ChatGPT to work with Xert. In this case as well, ChatGPT doesn't like the way Xert handles authentication, so I build a Cloudflare worker to act as a go-between.

The files CloudflareGasProxy and CloudflareXertProxy handle the go-between aspect.

Once done, I created a private custom ChatGPT which allows me to track my nutrition, take into account rides, discuss upcoming training plan, etc. It's a pretty awesome platform and something I think most folks would easily pay the $20/month that GPT charges for out of the box.
