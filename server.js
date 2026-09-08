const express = require('express');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const db = new Database('jmb_phase4.db');
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_IN_PRODUCTION';

db.pragma('foreign_keys = ON');
const schema = require('fs').readFileSync(path.join(__dirname,'schema.sql'),'utf8');
db.exec(schema);

app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,'public')));

function tokenFor(user){ return jwt.sign({id:user.id, role:user.role}, JWT_SECRET, {expiresIn:'7d'}); }
function auth(req,res,next){
  const h=req.headers.authorization||'';
  if(!h.startsWith('Bearer ')) return res.status(401).json({error:'Login required'});
  try { req.user=jwt.verify(h.slice(7),JWT_SECRET); next(); }
  catch(e){ return res.status(401).json({error:'Invalid/expired login'}); }
}
function admin(req,res,next){
  if(req.user?.role!=='admin') return res.status(403).json({error:'Admin only'});
  next();
}
function isPaid(userId){
  const m=db.prepare(`SELECT 1 FROM memberships WHERE user_id=? AND status='active'
    AND (end_at IS NULL OR datetime(end_at)>datetime('now')) LIMIT 1`).get(userId);
  return !!m;
}

/* Demo login: any existing/new mobile gets a demo account.
   Production must use real OTP verification. */
app.post('/api/login', (req,res)=>{
  const mobile=String(req.body.mobile||'').trim();
  const otp=String(req.body.otp||'').trim();
  if(!/^[0-9]{10}$/.test(mobile)) return res.status(400).json({error:'10 digit mobile required'});
  if(!/^[0-9]{6}$/.test(otp)) return res.status(400).json({error:'6 digit demo OTP required'});
  let u=db.prepare('SELECT * FROM users WHERE mobile=?').get(mobile);
  if(!u){ const info=db.prepare('INSERT INTO users(mobile) VALUES(?)').run(mobile); u=db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid); }
  res.json({token:tokenFor(u), user:{id:u.id,mobile:u.mobile,role:u.role,paid:isPaid(u.id)}});
});

app.get('/api/me',auth,(req,res)=>{
  const u=db.prepare('SELECT id,mobile,role,status FROM users WHERE id=?').get(req.user.id);
  res.json({...u,paid:isPaid(u.id)});
});

app.post('/api/membership/create',auth,(req,res)=>{
  const plans={monthly:{days:30,amount:299},quarterly:{days:90,amount:699},yearly:{days:365,amount:1999}};
  const plan=plans[req.body.plan];
  if(!plan) return res.status(400).json({error:'Invalid plan'});
  const info=db.prepare(`INSERT INTO memberships(user_id,plan_name,amount,status) VALUES(?,?,?,'pending')`)
    .run(req.user.id,req.body.plan,plan.amount);
  res.json({membership_id:info.lastInsertRowid, amount:plan.amount, days:plan.days,
    message:'Payment gateway placeholder created. Admin can activate this demo payment.'});
});

/* DEMO payment confirmation. Production: replace with gateway order + signature verification. */
app.post('/api/membership/demo-pay',auth,(req,res)=>{
  const m=db.prepare(`SELECT * FROM memberships WHERE id=? AND user_id=? AND status='pending'`)
    .get(req.body.membership_id,req.user.id);
  if(!m) return res.status(404).json({error:'Membership not found'});
  const days={monthly:30,quarterly:90,yearly:365}[m.plan_name]||30;
  const start=new Date();
  const end=new Date(start.getTime()+days*86400000);
  db.prepare(`UPDATE memberships SET status='active',start_at=?,end_at=?,payment_ref=? WHERE id=?`)
    .run(start.toISOString(),end.toISOString(),'DEMO-'+Date.now(),m.id);
  res.json({success:true,message:'Demo membership activated',end_at:end.toISOString()});
});

app.get('/api/memberships',auth,(req,res)=>{
  const rows=db.prepare(`SELECT id,plan_name,amount,status,start_at,end_at,payment_ref,created_at
    FROM memberships WHERE user_id=? ORDER BY id DESC`).all(req.user.id);
  res.json(rows);
});

/* Free members see only safe preview fields. Paid members see more, subject to privacy. */
app.get('/api/profiles',auth,(req,res)=>{
  const paid=isPaid(req.user.id);
  const rows=db.prepare(`SELECT p.*, u.mobile FROM profiles p JOIN users u ON u.id=p.user_id
    WHERE p.status='approved' AND u.status='active' AND u.id NOT IN (SELECT user_id FROM blocked_users)
    ORDER BY p.id DESC`).all();
  res.json(rows.map(p=>{
    if(!paid) return {id:p.id,user_id:p.user_id,gender:p.gender,name:p.name,age:p.age,education:p.education};
    const privacy=db.prepare('SELECT mobile_visibility FROM privacy_settings WHERE user_id=?').get(p.user_id);
    let mobile=null;
    if(privacy?.mobile_visibility==='paid') mobile=p.mobile;
    return {...p,mobile};
  }));
});

app.post('/api/admin-request',auth,(req,res)=>{
  db.prepare('INSERT INTO admin_requests(user_id,message) VALUES(?,?)').run(req.user.id,String(req.body.message||''));
  res.json({success:true,message:'Admin को आपका अनुरोध भेज दिया गया।'});
});

app.get('/api/admin/dashboard',auth,admin,(req,res)=>{
  const count=(sql)=>db.prepare(sql).get().n;
  res.json({
    users:count("SELECT COUNT(*) n FROM users"),
    pendingProfiles:count("SELECT COUNT(*) n FROM profiles WHERE status='pending'"),
    pendingPhotos:count("SELECT COUNT(*) n FROM photos WHERE status='pending'"),
    pendingMemberships:count("SELECT COUNT(*) n FROM memberships WHERE status='pending'"),
    pendingContacts:count("SELECT COUNT(*) n FROM contact_requests WHERE status='pending'"),
    pendingAdminRequests:count("SELECT COUNT(*) n FROM admin_requests WHERE status='pending'"),
openReports:count("SELECT COUNT(*) AS n FROM reports WHERE status='open'") 
  });
});

app.get('/api/admin/profiles',auth,admin,(req,res)=>{
  res.json(db.prepare(`SELECT p.*,u.mobile FROM profiles p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC`).all());
});
app.post('/api/admin/profile-status',auth,admin,(req,res)=>{
  const status=['approved','rejected','pending'].includes(req.body.status)?req.body.status:null;
  if(!status) return res.status(400).json({error:'Invalid status'});
  db.prepare('UPDATE profiles SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,req.body.profile_id);
  res.json({success:true});
});

app.get('/api/admin/photos',auth,admin,(req,res)=>{
  res.json(db.prepare(`SELECT photos.*,users.mobile FROM photos JOIN users ON users.id=photos.user_id ORDER BY photos.id DESC`).all());
});
app.post('/api/admin/photo-status',auth,admin,(req,res)=>{
  const status=['approved','rejected','pending'].includes(req.body.status)?req.body.status:null;
  if(!status) return res.status(400).json({error:'Invalid status'});
  db.prepare('UPDATE photos SET status=? WHERE id=?').run(status,req.body.photo_id);
  res.json({success:true});
});

app.get('/api/admin/memberships',auth,admin,(req,res)=>{
  res.json(db.prepare(`SELECT memberships.*,users.mobile FROM memberships JOIN users ON users.id=memberships.user_id ORDER BY memberships.id DESC`).all());
});
app.post('/api/admin/membership-status',auth,admin,(req,res)=>{
  const status=['active','rejected','expired','pending'].includes(req.body.status)?req.body.status:null;
  if(!status) return res.status(400).json({error:'Invalid status'});
  let end=null;
  if(status==='active'){
    const days={monthly:30,quarterly:90,yearly:365}[req.body.plan_name]||30;
    end=new Date(Date.now()+days*86400000).toISOString();
  }
  db.prepare(`UPDATE memberships SET status=?,start_at=CASE WHEN ?='active' THEN CURRENT_TIMESTAMP ELSE start_at END,
    end_at=CASE WHEN ?='active' THEN ? ELSE end_at END WHERE id=?`)
    .run(status,status,status,end,req.body.membership_id);
  res.json({success:true});
});

app.get('/api/admin/requests',auth,admin,(req,res)=>{
  res.json({
    contacts:db.prepare(`SELECT * FROM contact_requests ORDER BY id DESC`).all(),
    marriage:db.prepare(`SELECT * FROM admin_requests ORDER BY id DESC`).all(),
    reports:db.prepare(`SELECT * FROM reports ORDER BY id DESC`).all()
  });
});

app.post('/api/admin/request-status',auth,admin,(req,res)=>{
  const table=req.body.type==='contact'?'contact_requests':req.body.type==='marriage'?'admin_requests':'reports';
  const allowed=['pending','accepted','rejected','closed','blocked'];
  if(!allowed.includes(req.body.status)) return res.status(400).json({error:'Invalid status'});
  db.prepare(`UPDATE ${table} SET status=? WHERE id=?`).run(req.body.status,req.body.id);
  res.json({success:true});
});

app.get('/api/admin/settings',auth,admin,(req,res)=>{
  res.json(Object.fromEntries(db.prepare('SELECT key,value FROM admin_settings').all().map(x=>[x.key,x.value])));
});
app.post('/api/admin/settings',auth,admin,(req,res)=>{
  const allowed=['admin_name','admin_mobile','admin_whatsapp','contact_message'];
  const stmt=db.prepare('INSERT INTO admin_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for(const k of allowed) if(req.body[k]!==undefined) stmt.run(k,String(req.body[k]));
  res.json({success:true});
});

app.listen(PORT,()=>console.log(`JMB Phase 4 running on http://localhost:${PORT}`));
