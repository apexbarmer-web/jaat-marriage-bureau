# JMB Phase 4 — Paid Membership + Admin Dashboard

यह Phase 4, Phase 3 के ऊपर बनाया गया ढांचा है।

मुख्य हिस्से:
- Membership plans
- Payment record structure
- Membership activation/expiry
- Admin dashboard
- Profile approval
- Photo approval
- Contact request management
- Admin-mediated marriage requests
- Reports and blocking
- Admin contact settings
- Server-side access control

महत्वपूर्ण:
1. Payment gateway अभी DEMO/placeholder है। असली Razorpay/Cashfree credentials लगाने से पहले server-side signature verification जोड़ना जरूरी है।
2. OTP अभी demo है; production में SMS OTP provider, expiry और attempt limits जरूरी हैं।
3. JWT_SECRET को production में मजबूत environment secret से बदलें।
4. Database में personal data है; Privacy Policy, Terms, consent, delete-account और access controls लागू करें।

चलाने के लिए:
npm install
node server.js

फिर browser में:
http://localhost:3000

Demo admin:
Email: admin@jmb.local
Password: ChangeThisAdminPassword123
(Production में तुरंत बदलें।)
