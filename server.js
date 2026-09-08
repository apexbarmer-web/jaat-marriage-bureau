const express = require('express');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const app = express();

const db = new Database('jmb_phase4.db');

const PORT = process.env.PORT || 3000;

const JWT_SECRET =
  process.env.JWT_SECRET || 'CHANGE_ME_IN_PRODUCTION';

db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(
  path.join(__dirname, 'schema.sql'),
  'utf8'
);

db.exec(schema);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  express.static(path.join(__dirname, 'public'))
);


/* =========================
   HELPER FUNCTIONS
========================= */

function tokenFor(user) {

  return jwt.sign(
    {
      id: user.id,
      role: user.role
    },
    JWT_SECRET,
    {
      expiresIn: '7d'
    }
  );

}


function auth(req, res, next) {

  const h = req.headers.authorization || '';

  if (!h.startsWith('Bearer ')) {

    return res.status(401).json({
      error: 'Login required'
    });

  }

  try {

    req.user = jwt.verify(
      h.slice(7),
      JWT_SECRET
    );

    next();

  } catch (e) {

    return res.status(401).json({
      error: 'Invalid/expired login'
    });

  }

}


function admin(req, res, next) {

  if (req.user?.role !== 'admin') {

    return res.status(403).json({
      error: 'Admin only'
    });

  }

  next();

}


function isPaid(userId) {

  const m = db.prepare(`
    SELECT 1
    FROM memberships
    WHERE user_id=?
    AND status='active'
    AND (
      end_at IS NULL
      OR datetime(end_at)>datetime('now')
    )
    LIMIT 1
  `).get(userId);

  return !!m;

}


/* =========================
   LOGIN / REGISTRATION
========================= */

/*
   Demo member login:
   Any valid 10 digit mobile + any 6 digit OTP.

   Admin login:
   ADMIN_MOBILE and ADMIN_OTP
   will be set in Render Environment Variables.
*/

app.post('/api/login', (req, res) => {

  const mobile =
    String(req.body.mobile || '').trim();

  const otp =
    String(req.body.otp || '').trim();


  if (!/^[0-9]{10}$/.test(mobile)) {

    return res.status(400).json({
      error: '10 digit mobile required'
    });

  }


  if (!/^[0-9]{6}$/.test(otp)) {

    return res.status(400).json({
      error: '6 digit OTP required'
    });

  }


  const adminMobile =
    String(process.env.ADMIN_MOBILE || '').trim();

  const adminOtp =
    String(process.env.ADMIN_OTP || '').trim();


  let user;


  /*
     ADMIN LOGIN
  */

  if (
    adminMobile &&
    adminOtp &&
    mobile === adminMobile &&
    otp === adminOtp
  ) {

    user = db.prepare(
      'SELECT * FROM users WHERE mobile=?'
    ).get(mobile);


    if (!user) {

      const info = db.prepare(`
        INSERT INTO users
        (mobile, role, status)
        VALUES (?, 'admin', 'active')
      `).run(mobile);

      user = db.prepare(
        'SELECT * FROM users WHERE id=?'
      ).get(info.lastInsertRowid);

    } else {

      db.prepare(`
        UPDATE users
        SET role='admin', status='active'
        WHERE id=?
      `).run(user.id);

      user = db.prepare(
        'SELECT * FROM users WHERE id=?'
      ).get(user.id);

    }

  }


  /*
     MEMBER LOGIN
  */

  else {

    user = db.prepare(
      'SELECT * FROM users WHERE mobile=?'
    ).get(mobile);


    if (!user) {

      const info = db.prepare(`
        INSERT INTO users
        (mobile, role, status)
        VALUES (?, 'member', 'active')
      `).run(mobile);

      user = db.prepare(
        'SELECT * FROM users WHERE id=?'
      ).get(info.lastInsertRowid);

    }


    if (user.status !== 'active') {

      return res.status(403).json({
        error: 'Account is not active'
      });

    }

  }


  res.json({

    token: tokenFor(user),

    user: {
      id: user.id,
      mobile: user.mobile,
      role: user.role,
      paid: isPaid(user.id)
    }

  });

});


/* =========================
   CURRENT USER
========================= */

app.get('/api/me', auth, (req, res) => {

  const user = db.prepare(`
    SELECT
      id,
      mobile,
      role,
      status
    FROM users
    WHERE id=?
  `).get(req.user.id);


  if (!user) {

    return res.status(404).json({
      error: 'User not found'
    });

  }


  res.json({
    ...user,
    paid: isPaid(user.id)
  });

});


/* =========================
   MEMBERSHIP
========================= */

app.post(
  '/api/membership/create',
  auth,
  (req, res) => {

    const plans = {

      monthly: {
        days: 30,
        amount: 299
      },

      quarterly: {
        days: 90,
        amount: 699
      },

      yearly: {
        days: 365,
        amount: 1999
      }

    };


    const plan = plans[req.body.plan];


    if (!plan) {

      return res.status(400).json({
        error: 'Invalid plan'
      });

    }


    const info = db.prepare(`
      INSERT INTO memberships
      (user_id, plan_name, amount, status)
      VALUES (?, ?, ?, 'pending')
    `).run(
      req.user.id,
      req.body.plan,
      plan.amount
    );


    res.json({

      membership_id: info.lastInsertRowid,

      amount: plan.amount,

      days: plan.days,

      message:
        'Payment gateway placeholder created. Demo payment can be activated.'

    });

  }
);


/* =========================
   DEMO PAYMENT
========================= */

app.post(
  '/api/membership/demo-pay',
  auth,
  (req, res) => {

    const membership = db.prepare(`
      SELECT *
      FROM memberships
      WHERE id=?
      AND user_id=?
      AND status='pending'
    `).get(
      req.body.membership_id,
      req.user.id
    );


    if (!membership) {

      return res.status(404).json({
        error: 'Membership not found'
      });

    }


    const days = {

      monthly: 30,

      quarterly: 90,

      yearly: 365

    }[membership.plan_name] || 30;


    const start = new Date();

    const end = new Date(
      start.getTime() +
      days * 86400000
    );


    db.prepare(`
      UPDATE memberships
      SET
        status='active',
        start_at=?,
        end_at=?,
        payment_ref=?
      WHERE id=?
    `).run(
      start.toISOString(),
      end.toISOString(),
      'DEMO-' + Date.now(),
      membership.id
    );


    res.json({

      success: true,

      message:
        'Demo membership activated',

      end_at:
        end.toISOString()

    });

  }
);


/* =========================
   MEMBER MEMBERSHIPS
========================= */

app.get(
  '/api/memberships',
  auth,
  (req, res) => {

    const rows = db.prepare(`
      SELECT
        id,
        plan_name,
        amount,
        status,
        start_at,
        end_at,
        payment_ref,
        created_at
      FROM memberships
      WHERE user_id=?
      ORDER BY id DESC
    `).all(req.user.id);


    res.json(rows);

  }
);


/* =========================
   APPROVED PROFILES
========================= */

app.get(
  '/api/profiles',
  auth,
  (req, res) => {

    const paid =
      isPaid(req.user.id);


    const rows = db.prepare(`
      SELECT
        p.*,
        u.mobile
      FROM profiles p
      JOIN users u
        ON u.id=p.user_id
      WHERE
        p.status='approved'
        AND u.status='active'
        AND u.id NOT IN (
          SELECT user_id
          FROM blocked_users
        )
      ORDER BY p.id DESC
    `).all();


    res.json(

      rows.map(profile => {

        /*
           FREE MEMBER
           Only preview information
        */

        if (!paid) {

          return {

            id: profile.id,

            user_id: profile.user_id,

            gender: profile.gender,

            name: profile.name,

            age: profile.age,

            education: profile.education

          };

        }


        /*
           PAID MEMBER
           Privacy rules applied
        */

        const privacy =
          db.prepare(`
            SELECT mobile_visibility
            FROM privacy_settings
            WHERE user_id=?
          `).get(profile.user_id);


        let mobile = null;


        if (
          privacy?.mobile_visibility === 'paid'
        ) {

          mobile = profile.mobile;

        }


        return {

          ...profile,

          mobile

        };

      })

    );

  }
);


/* =========================
   ADMIN REQUEST
========================= */

app.post(
  '/api/admin-request',
  auth,
  (req, res) => {

    const message =
      String(req.body.message || '').trim();


    db.prepare(`
      INSERT INTO admin_requests
      (user_id, message)
      VALUES (?, ?)
    `).run(
      req.user.id,
      message
    );


    res.json({

      success: true,

      message:
        'Admin को आपका अनुरोध भेज दिया गया।'

    });

  }
);


/* =========================
   ADMIN DASHBOARD SUMMARY
========================= */

app.get(
  '/api/admin/dashboard',
  auth,
  admin,
  (req, res) => {

    const count = sql =>
      db.prepare(sql).get().n;


    res.json({

      users:
        count(
          `SELECT COUNT(*) n FROM users`
        ),

      pendingProfiles:
        count(
          `SELECT COUNT(*) n
           FROM profiles
           WHERE status='pending'`
        ),

      pendingPhotos:
        count(
          `SELECT COUNT(*) n
           FROM photos
           WHERE status='pending'`
        ),

      pendingMemberships:
        count(
          `SELECT COUNT(*) n
           FROM memberships
           WHERE status='pending'`
        ),

      pendingContacts:
        count(
          `SELECT COUNT(*) n
           FROM contact_requests
           WHERE status='pending'`
        ),

      pendingAdminRequests:
        count(
          `SELECT COUNT(*) n
           FROM admin_requests
           WHERE status='pending'`
        ),

      openReports:
        count(
          `SELECT COUNT(*) n
           FROM reports
           WHERE status='open'`
        )

    });

  }
);


/* =========================
   ADMIN PROFILES
========================= */

app.get(
  '/api/admin/profiles',
  auth,
  admin,
  (req, res) => {

    const rows = db.prepare(`
      SELECT
        p.*,
        u.mobile
      FROM profiles p
      JOIN users u
        ON u.id=p.user_id
      ORDER BY p.id DESC
    `).all();


    res.json(rows);

  }
);


app.post(
  '/api/admin/profile-status',
  auth,
  admin,
  (req, res) => {

    const allowed = [
      'approved',
      'rejected',
      'pending'
    ];


    if (
      !allowed.includes(req.body.status)
    ) {

      return res.status(400).json({
        error: 'Invalid status'
      });

    }


    db.prepare(`
      UPDATE profiles
      SET
        status=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      req.body.status,
      req.body.profile_id
    );


    res.json({
      success: true
    });

  }
);


/* =========================
   ADMIN PHOTOS
========================= */

app.get(
  '/api/admin/photos',
  auth,
  admin,
  (req, res) => {

    const rows = db.prepare(`
      SELECT
        photos.*,
        users.mobile
      FROM photos
      JOIN users
        ON users.id=photos.user_id
      ORDER BY photos.id DESC
    `).all();


    res.json(rows);

  }
);


app.post(
  '/api/admin/photo-status',
  auth,
  admin,
  (req, res) => {

    const allowed = [
      'approved',
      'rejected',
      'pending'
    ];


    if (
      !allowed.includes(req.body.status)
    ) {

      return res.status(400).json({
        error: 'Invalid status'
      });

    }


    db.prepare(`
      UPDATE photos
      SET status=?
      WHERE id=?
    `).run(
      req.body.status,
      req.body.photo_id
    );


    res.json({
      success: true
    });

  }
);


/* =========================
   ADMIN MEMBERSHIPS
========================= */

app.get(
  '/api/admin/memberships',
  auth,
  admin,
  (req, res) => {

    const rows = db.prepare(`
      SELECT
        memberships.*,
        users.mobile
      FROM memberships
      JOIN users
        ON users.id=memberships.user_id
      ORDER BY memberships.id DESC
    `).all();


    res.json(rows);

  }
);


app.post(
  '/api/admin/membership-status',
  auth,
  admin,
  (req, res) => {

    const allowed = [
      'active',
      'rejected',
      'expired',
      'pending'
    ];


    if (
      !allowed.includes(req.body.status)
    ) {

      return res.status(400).json({
        error: 'Invalid status'
      });

    }


    let end = null;


    if (
      req.body.status === 'active'
    ) {

      const days = {

        monthly: 30,

        quarterly: 90,

        yearly: 365

      }[req.body.plan_name] || 30;


      end =
        new Date(
          Date.now() +
          days * 86400000
        ).toISOString();

    }


    db.prepare(`
      UPDATE memberships
      SET
        status=?,
        start_at=
          CASE
            WHEN ?='active'
            THEN CURRENT_TIMESTAMP
            ELSE start_at
          END,
        end_at=
          CASE
            WHEN ?='active'
            THEN ?
            ELSE end_at
          END
      WHERE id=?
    `).run(
      req.body.status,
      req.body.status,
      req.body.status,
      end,
      req.body.membership_id
    );


    res.json({
      success: true
    });

  }
);


/* =========================
   ADMIN REQUESTS
========================= */

app.get(
  '/api/admin/requests',
  auth,
  admin,
  (req, res) => {

    res.json({

      contacts:
        db.prepare(`
          SELECT *
          FROM contact_requests
          ORDER BY id DESC
        `).all(),

      marriage:
        db.prepare(`
          SELECT *
          FROM admin_requests
          ORDER BY id DESC
        `).all(),

      reports:
        db.prepare(`
          SELECT *
          FROM reports
          ORDER BY id DESC
        `).all()

    });

  }
);


app.post(
  '/api/admin/request-status',
  auth,
  admin,
  (req, res) => {

    const table =
      req.body.type === 'contact'
        ? 'contact_requests'
        : req.body.type === 'marriage'
        ? 'admin_requests'
        : 'reports';


    const allowed = [
      'pending',
      'accepted',
      'rejected',
      'closed',
      'blocked'
    ];


    if (
      !allowed.includes(req.body.status)
    ) {

      return res.status(400).json({
        error: 'Invalid status'
      });

    }


    db.prepare(
      `UPDATE ${table}
       SET status=?
       WHERE id=?`
    ).run(
      req.body.status,
      req.body.id
    );


    res.json({
      success: true
    });

  }
);


/* =========================
   ADMIN SETTINGS
========================= */

app.get(
  '/api/admin/settings',
  auth,
  admin,
  (req, res) => {

    const rows =
      db.prepare(`
        SELECT key,value
        FROM admin_settings
      `).all();


    res.json(
      Object.fromEntries(
        rows.map(x => [
          x.key,
          x.value
        ])
      )
    );

  }
);


app.post(
  '/api/admin/settings',
  auth,
  admin,
  (req, res) => {

    const allowed = [

      'admin_name',

      'admin_mobile',

      'admin_whatsapp',

      'contact_message',

      'admin_advice'

    ];


    const stmt = db.prepare(`
      INSERT INTO admin_settings
      (key,value)
      VALUES (?,?)
      ON CONFLICT(key)
      DO UPDATE SET value=excluded.value
    `);


    for (
      const key of allowed
    ) {

      if (
        req.body[key] !== undefined
      ) {

        stmt.run(
          key,
          String(req.body[key])
        );

      }

    }


    res.json({
      success: true
    });

  }
);


/* =========================
   PUBLIC ADMIN ADVICE
========================= */

app.get(
  '/api/public-settings',
  (req, res) => {

    const rows = db.prepare(`
      SELECT key,value
      FROM admin_settings
      WHERE key IN (
        'admin_name',
        'contact_message',
        'admin_advice'
      )
    `).all();


    res.json(
      Object.fromEntries(
        rows.map(x => [
          x.key,
          x.value
        ])
      )
    );

  }
);


/* =========================
   START SERVER
========================= */

app.listen(
  PORT,
  () => {

    console.log(
      `Jaat Marriage Bureau running on port ${PORT}`
    );

  }
);
