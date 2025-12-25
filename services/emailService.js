
const nodemailer = require("nodemailer");

const createTransporter = async () => {
  // Check if we have real credentials
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    return nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }

  // Fallback to Ethereal (Dev Mode)
  console.log("⚠️ No real email credentials found. Using Ethereal (Fake Email) for testing.");
  const testAccount = await nodemailer.createTestAccount();

  return nodemailer.createTransport({
    host: "smtp.ethereal.email",
    port: 587,
    secure: false,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
  });
};

const sendVerificationEmail = async (email, token) => {
  const transporter = await createTransporter();
  const baseUrl = process.env.BASE_URL || "http://localhost:8000";
  const verificationLink = `${baseUrl}/user/verify/${token}`;

  const info = await transporter.sendMail({
    from: '"Lumina" <noreply@lumina.com>',
    to: email,
    subject: "Verify your email address",
    html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            .header { text-align: center; margin-bottom: 30px; }
            .logo { font-size: 24px; font-weight: bold; color: #1a1a1a; text-decoration: none; }
            .content { color: #444444; line-height: 1.6; font-size: 16px; }
            .button-container { text-align: center; margin: 30px 0; }
            .button { background-color: #000000; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block; }
            .footer { margin-top: 30px; text-align: center; color: #888888; font-size: 12px; border-top: 1px solid #eeeeee; padding-top: 20px; }
            .link-text { color: #666666; font-size: 14px; word-break: break-all; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <a href="${baseUrl}" class="logo">Lumina</a>
            </div>
            <div class="content">
              <h2>Welcome to Lumina!</h2>
              <p>We're excited to have you join our community. To complete your registration and unlock full access to your account, please verify your email address.</p>
              
              <div class="button-container">
                <a href="${verificationLink}" class="button">Verify My Email</a>
              </div>
              
              <p>Or verify using this link:</p>
              <p class="link-text">${verificationLink}</p>
              
              <p>If you didn't create an account with Lumina, you can safely ignore this email.</p>
            </div>
            <div class="footer">
              <p>&copy; ${new Date().getFullYear()} Lumina. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
    `,
  });

  console.log("📨 Email sent: %s", info.messageId);

  // If using Ethereal, print the preview URL
  if (nodemailer.getTestMessageUrl(info)) {
    console.log("🔎 Preview URL: %s", nodemailer.getTestMessageUrl(info));
  }
};

const sendResetPasswordEmail = async (email, resetLink) => {
  const transporter = await createTransporter();

  const info = await transporter.sendMail({
    from: '"Lumina" <noreply@lumina.com>',
    to: email,
    subject: "Reset Your Password",
    html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            .header { text-align: center; margin-bottom: 30px; }
            .logo { font-size: 24px; font-weight: bold; color: #1a1a1a; text-decoration: none; }
            .content { color: #444444; line-height: 1.6; font-size: 16px; }
            .button-container { text-align: center; margin: 30px 0; }
            .button { background-color: #d90429; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block; }
            .footer { margin-top: 30px; text-align: center; color: #888888; font-size: 12px; border-top: 1px solid #eeeeee; padding-top: 20px; }
            .link-text { color: #666666; font-size: 14px; word-break: break-all; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <a href="#" class="logo">Lumina</a>
            </div>
            <div class="content">
              <h2>Password Reset Request</h2>
              <p>We received a request to reset your password. If this was you, you can change your password using the button below. This link works for 1 hour.</p>
              
              <div class="button-container">
                <a href="${resetLink}" class="button">Reset Password</a>
              </div>
              
              <p>Or copy this link:</p>
              <p class="link-text">${resetLink}</p>
              
              <p><strong>Did not request this?</strong><br>
              Please ignore this email. Your password will remain unchanged and your account is secure.</p>
            </div>
            <div class="footer">
              <p>&copy; ${new Date().getFullYear()} Lumina. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
    `,
  });

  console.log("📨 Reset Email sent: %s", info.messageId);

  if (nodemailer.getTestMessageUrl(info)) {
    console.log("🔎 Preview URL: %s", nodemailer.getTestMessageUrl(info));
  }
};

module.exports = { sendVerificationEmail, sendResetPasswordEmail, createTransporter };
