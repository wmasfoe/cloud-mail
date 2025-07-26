
<p align="center">
  <img src="doc/demo/logo.png" width="80px" />
</p>

<div align="center">
<h1>Cloud Mail</h1>
</div>
<div align="center">
    <h4>A responsive email service built with Vue 3 that supports email sending and can be deployed on Cloudflare. 🎉</h4> 
</div>


## Project Showcase

[**👉 Online Demo**](https://skymail.ink)

[**👉 Beginner’s Guide – UI Deployment**](https://doc.skymail.ink)

| ![](/doc/demo/demo1.png) | ![](/doc/demo/demo2.png) |
|--------------------------|---------------------|
| ![](/doc/demo/demo3.png) | ![](/doc/demo/demo4.png) |
| ![](/doc/demo/demo5.png) | ![](/doc/demo/demo6.png) |
| ![](/doc/demo/demo7.png) | ![](/doc/demo/demo8.png) |

## Features

- **💻 Responsive Design**: Automatically adapts to both desktop and most mobile browsers.

- **📧 Email Sending**: Integrated with Resend for bulk email sending, embedded images, attachments, and status tracking.

- **🛡️ Admin Features**: Admins can manage users and emails, with RBAC permission control to limit access to features and resources.

- **🔀 Multiple Accounts**: Users can add multiple email accounts. 

- **📦 Attachment Support**: Send and receive attachments, stored and downloaded via R2 object storage.

- **🔔 Email Push**: Forward received emails to Telegram bots or other email providers.

- **📈 Data Visualization**: Use Echarts to visualize system data, including user email growth.

- **⭐ Starred Emails**: Mark important emails for quick access.

- **🎨 Personalization**: Customize website title, login background, and transparency.

- **⚙️ Feature Settings**: Toggle on or off features like registration, email sending, and more, with the option to make the site private.

- **🤖 CAPTCHA**: Integrated with Turnstile CAPTCHA to prevent automated registration.

- **📜 More Features**: Under development...

## Tech Stack

- **Framework**: [Vue3](https://vuejs.org/) + [Element Plus](https://element-plus.org/)

- **Web Framework**: [Hono](https://hono.dev/)

- **ORM**: [Drizzle](https://orm.drizzle.team/)

- **Platform**: [Cloudflare Workers](https://developers.cloudflare.com/workers/)

- **Email Service**: [Resend](https://resend.com/)

- **Caching**: [Cloudflare KV](https://developers.cloudflare.com/kv/)

- **Database**: [Cloudflare D1](https://developers.cloudflare.com/d1/)

- **File Storage**: [Cloudflare R2](https://developers.cloudflare.com/r2/)

## Setup Guide

### System Requirements

Nodejs v18.20 +  

Cloudflare account (with a bound domain)

**Clone the project to your local machine:**
``` shell
git clone https://github.com/eoao/cloud-mail
cd cloud-mail/mail-worker
```

**Install Dependencies:**
```shell
npm i
```

**Configure the Project**

mail-worker/wrangler.toml

```toml
[[d1_databases]]
binding = "db"			# Default binding name for D1 database, cannot be changed
database_name = ""		# Database name
database_id = ""		# Database ID

[[kv_namespaces]]
binding = "kv"			# Default binding name for KV storage, cannot be changed
id = ""			        # KV namespace ID


[[r2_buckets]]
binding = "r2"                  # Default binding name for R2 storage, cannot be changed
bucket_name = ""	        # R2 bucket name

[assets]
binding = "assets"		# Static asset binding name, cannot be changed
directory = "./dist"	        # Directory for frontend Vue project build, default: dist

[vars]
orm_log = false
domain = []			# Configure email domains, example: ["example1.com", "example2.com"]
admin = ""		        # Admin email, example: "admin@example.com"
jwt_secret = ""			# JWT secret for login tokens, choose a random string
```

**Deploy Remotely**

1. Create KV, D1 database, and R2 object storage in Cloudflare Console.
2. In the project directory `mail-worker/wrangler.toml`, configure the environment variables and database IDs/names.
3. Run the deployment command:

    ```shell
    npm run deploy 
    ```

4. In Cloudflare → Account Home → Your Domain → Email → Email Routing → Route Rules → Catch-all Address, edit and route to the worker.

5. In your browser, visit  `https://your-project-domain/api/init/your-jwt-secret` to initialize or update the D1 and KV databases.

6. After deployment, log in to the site with the admin account to configure R2 domains, Turnstile keys, and more.


**Run Locally**

1. Run locally. Databases and object storage will automatically be set up, no manual creation needed. Data is stored in the `mail-worker/.wrangler` folder.

    ```shell
    npm run dev 
    ```

2. In your browser, visit `http://127.0.0.1:8787/api/init/your-jwt-secret` to initialize D1 and KV databases.

3. For local testing, you can set the R2 domain to `http://127.0.0.1:8787/api/file`.

**Email Sending**

1. Register on Resend, then click on “Domains” to add and verify your domain. Wait for verification.

2. Go to "API Keys" to create an API key, then copy the token and paste it in the project website settings.

3. Go to "Webhooks" and add a callback URL  `https://your-project-domain/api/webhooks`.  
   Select the following events: ✅ (email.bounced, email.complained, email.delivered, email.delivery_delayed).


**Project Update**

After the update, run `https://your-project-domain/api/init/your-jwt-secret` to synchronize the database schema.

## Support

<a href="https://support.skymail.ink">
<img width="170px" src="./doc/images/support.png" alt="">
</a><br><br>


**Special Sponsors**

[DartNode](https://dartnode.com)：Providing cloud computing service resource support

[![Powered by DartNode](https://dartnode.com/branding/DN-Open-Source-sm.png)](https://dartnode.com "Powered by DartNode - Free VPS for Open Source")

## License

This project is licensed under the [MIT](LICENSE) license.

## Communication

[Telegram](https://t.me/cloud_mail_tg)
