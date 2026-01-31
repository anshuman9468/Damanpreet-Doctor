const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');

const app = express();
const PORT = 3000;

// Function to get fresh environment variables (reloads .env file)
function getEnvConfig() {
    const envConfig = dotenv.config();
    return process.env;
}

// Email configuration is handled in the notification logic below

app.use(cors());
app.use(express.json());
// Serve static files from the current directory (so index.html is accessible)
app.use(express.static('.'));

// Root route - serve index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Explicit route for doctor image to ensure it's served correctly
app.get('/doctor_image.png', (req, res) => {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.sendFile(path.join(__dirname, 'doctor_image.png'), (err) => {
        if (err) {
            console.error('Error serving doctor_image.png:', err);
            res.status(404).send('Image not found');
        }
    });
});

const DATA_FILE = path.join(__dirname, 'appointments.json');
const IS_VERCEL = process.env.VERCEL === '1';

// In-memory storage for Vercel (read-only filesystem)
let inMemoryAppointments = [];

// Initialize data file if it doesn't exist (only for local development)
if (!IS_VERCEL) {
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify([]));
    }
    // Load existing appointments from file
    try {
        const data = fs.readFileSync(DATA_FILE);
        inMemoryAppointments = JSON.parse(data);
    } catch (error) {
        inMemoryAppointments = [];
    }
}

// Get all appointments
app.get('/api/appointments', (req, res) => {
    try {
        let appointments;
        if (IS_VERCEL) {
            // Use in-memory storage on Vercel
            appointments = inMemoryAppointments;
        } else {
            // Use file storage locally
            const data = fs.readFileSync(DATA_FILE);
            appointments = JSON.parse(data);
        }
        res.json(appointments);
    } catch (error) {
        console.error('Error reading appointments:', error);
        res.status(500).json({ error: 'Failed to read appointments' });
    }
});

// Book an appointment
app.post('/api/appointments', async (req, res) => {
    try {
        const { appointment_date, appointment_time, patientName, patientEmail, patientPhone, patientAdhaar, concern } = req.body;

        // Validation matches the frontend's expected payload
        if (!appointment_date || !appointment_time || !patientName) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Get appointments from appropriate storage
        let appointments;
        if (IS_VERCEL) {
            // Use in-memory storage on Vercel
            appointments = inMemoryAppointments;
        } else {
            // Use file storage locally
            try {
                const data = fs.readFileSync(DATA_FILE);
                appointments = JSON.parse(data);
            } catch (error) {
                appointments = [];
            }
        }

        // Check if slot is already taken
        const isTaken = appointments.some(appt =>
            appt.appointment_date === appointment_date &&
            appt.appointment_time === appointment_time
        );

        if (isTaken) {
            return res.status(409).json({ error: 'This time slot is already booked.' });
        }

        const newAppointment = {
            id: Date.now().toString(),
            appointment_date,
            appointment_time,
            patientName,
            patientEmail,
            patientPhone,
            patientAdhaar, // Added adhaar
            concern,
            createdAt: new Date().toISOString()
        };

        appointments.push(newAppointment);

        // Save to appropriate storage
        if (IS_VERCEL) {
            // Update in-memory storage on Vercel
            inMemoryAppointments = appointments;
        } else {
            // Save to file locally
            try {
                fs.writeFileSync(DATA_FILE, JSON.stringify(appointments, null, 2));
            } catch (error) {
                console.error('Failed to write to file, using in-memory storage:', error);
                inMemoryAppointments = appointments;
            }
        }

        console.log(`New appointment booked: ${appointment_date} at ${appointment_time} for ${patientName}`);

        // --- NOTIFICATION LOGIC ---

        // Notifications are now handled via Email (Nodemailer) strictly.

        // Reload environment variables to get latest .env changes
        const env = getEnvConfig();
        console.log('📧 Using email config - From:', env.EMAIL_USER, '| Admin To:', env.EMAIL_TO || env.EMAIL_USER);

        // 2. Email Notification (Nodemailer)
        if (env.EMAIL_USER && env.EMAIL_PASS) {
            // For Gmail: You MUST use an App Password, not your regular password
            // To generate an App Password:
            // 1. Go to https://myaccount.google.com/apppasswords
            // 2. Select "Mail" and "Other (Custom name)" 
            // 3. Enter a name like "Doctor Appointments"
            // 4. Copy the 16-character password and use it in .env as EMAIL_PASS

            const transporter = nodemailer.createTransport({
                service: env.EMAIL_SERVICE || 'gmail',
                auth: {
                    user: env.EMAIL_USER,
                    pass: env.EMAIL_PASS
                },
                // Additional Gmail settings for better compatibility
                tls: {
                    rejectUnauthorized: false
                }
            });

            // Verify transporter configuration
            try {
                await transporter.verify();
                console.log('Email server is ready to send messages');
            } catch (verifyError) {
                console.error('Email configuration error:', verifyError.message);
                if (verifyError.code === 'EAUTH') {
                    console.error('\n⚠️  GMAIL AUTHENTICATION ERROR ⚠️');
                    console.error('If you\'re using Gmail, you need to use an App Password, not your regular password.');
                    console.error('Steps to fix:');
                    console.error('1. Go to: https://myaccount.google.com/apppasswords');
                    console.error('2. Sign in and select "Mail" and "Other (Custom name)"');
                    console.error('3. Enter a name (e.g., "Doctor Appointments")');
                    console.error('4. Copy the 16-character password');
                    console.error('5. Update your .env file: EMAIL_PASS=<the-16-char-password>');
                    console.error('6. Make sure EMAIL_USER is your full Gmail address (e.g., yourname@gmail.com)\n');
                }
            }

            const emailOptions = {
                from: env.EMAIL_USER,
                to: env.EMAIL_TO || env.EMAIL_USER, // Default to self if not specified
                subject: `New Appointment: ${patientName} - ${appointment_date}`,
                text: `
New Appointment Booking Received!

Details:
--------
Name: ${patientName}
Date: ${appointment_date}
Time: ${appointment_time}
Phone: ${patientPhone || 'N/A'}
Aadhaar: ${patientAdhaar || 'N/A'}
Email: ${patientEmail || 'N/A'}
Concern: ${concern || 'N/A'}

Full JSON Data:
${JSON.stringify(newAppointment, null, 2)}
                `,
                html: `
                    <h2>New Appointment Booking Received!</h2>
                    <p><strong>Name:</strong> ${patientName}</p>
                    <p><strong>Date:</strong> ${appointment_date}</p>
                    <p><strong>Time:</strong> ${appointment_time}</p>
                    <p><strong>Phone:</strong> ${patientPhone || 'N/A'}</p>
                    <p><strong>Aadhaar:</strong> ${patientAdhaar || 'N/A'}</p>
                    <p><strong>Email:</strong> ${patientEmail || 'N/A'}</p>
                    <p><strong>Concern:</strong> ${concern || 'N/A'}</p>
                    <br/>
                    <h3>Full JSON Data:</h3>
                    <pre style="background: #f4f4f4; padding: 10px; border-radius: 5px;">${JSON.stringify(newAppointment, null, 2)}</pre>
                `
            };

            try {
                await transporter.sendMail(emailOptions);
                console.log('✅ Admin email notification sent successfully to', emailOptions.to);
            } catch (emailError) {
                console.error('❌ Failed to send admin email notification:', emailError.message);
                if (emailError.code === 'EAUTH') {
                    console.error('\n⚠️  GMAIL AUTHENTICATION ERROR ⚠️');
                    console.error('If you\'re using Gmail, you need to use an App Password, not your regular password.');
                    console.error('Steps to fix:');
                    console.error('1. Go to: https://myaccount.google.com/apppasswords');
                    console.error('2. Sign in and select "Mail" and "Other (Custom name)"');
                    console.error('3. Enter a name (e.g., "Doctor Appointments")');
                    console.error('4. Copy the 16-character password');
                    console.error('5. Update your .env file: EMAIL_PASS=<the-16-char-password>');
                    console.error('6. Make sure EMAIL_USER is your full Gmail address (e.g., yourname@gmail.com)\n');
                }
            }

            // Send confirmation email to patient
            if (patientEmail) {
                const patientEmailOptions = {
                    from: env.EMAIL_USER,
                    to: patientEmail,
                    subject: `Appointment Confirmation - ${appointment_date}`,
                    text: `
Hi ${patientName},

Your Appointment is fixed with us on-:

Date: ${appointment_date}
Time: ${appointment_time}
${patientPhone ? `Phone: ${patientPhone}` : ''}
${patientAdhaar ? `Aadhaar: ${patientAdhaar}` : ''}
${concern ? `Concern: ${concern}` : ''}

I am happy to coordinate with you. Please send me "Hi, I had made a session booked regarding ${concern || 'your therapy session'}." on this whatsapp number-: 
+91 95604 76606
                    `,
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                            <h2 style="color: #2c3e50;">Hi ${patientName},</h2>
                            <p style="font-size: 16px; color: #34495e;">Your Appointment is fixed with us on-:</p>
                            
                            <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
                                <p style="margin: 10px 0;"><strong>Date:</strong> ${appointment_date}</p>
                                <p style="margin: 10px 0;"><strong>Time:</strong> ${appointment_time}</p>
                                ${patientPhone ? `<p style="margin: 10px 0;"><strong>Phone:</strong> ${patientPhone}</p>` : ''}
                                ${patientAdhaar ? `<p style="margin: 10px 0;"><strong>Aadhaar:</strong> ${patientAdhaar}</p>` : ''}
                                ${concern ? `<p style="margin: 10px 0;"><strong>Concern:</strong> ${concern}</p>` : ''}
                            </div>
                            
                            <p style="font-size: 16px; color: #34495e; margin-top: 20px;">
                                I am happy to coordinate with you. Please send me "Hi, I had made a session booked regarding ${concern || 'your therapy session'}." on this whatsapp number-: <br>
                                <strong>+91 95604 76606</strong>
                            </p>
                            
                            <p style="font-size: 16px; color: #2c3e50; font-weight: bold; margin-top: 20px;">
                                Happy to Assist you!!
                            </p>
                        </div>
                    `
                };

                try {
                    await transporter.sendMail(patientEmailOptions);
                    console.log('✅ Patient confirmation email sent successfully to', patientEmail);
                } catch (patientEmailError) {
                    console.error('❌ Failed to send patient confirmation email:', patientEmailError.message);
                }
            } else {
                console.log('ℹ️  No patient email provided, skipping patient confirmation email');
            }
        } else {
            console.warn('⚠️  Email credentials not configured. Set EMAIL_USER and EMAIL_PASS in .env file to enable email notifications.');
        }
        // --------------------------

        res.status(201).json(newAppointment);
    } catch (error) {
        console.error('Error saving appointment:', error);
        res.status(500).json({ error: 'Failed to save appointment' });
    }
});

// Export for Vercel serverless functions
module.exports = app;

// Start server locally (only if not in Vercel environment)
if (process.env.VERCEL !== '1') {
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}
