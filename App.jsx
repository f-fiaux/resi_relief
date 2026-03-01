import { useState, useRef, useEffect } from "react";

// ── Storage ──────────────────────────────────────────────────────────────────
async function loadData() {
  try { const r = await window.storage.get("relief-data-v2"); return r ? JSON.parse(r.value) : null; }
  catch { return null; }
}
async function saveData(d) {
  try { await window.storage.set("relief-data-v2", JSON.stringify(d)); } catch {}
}
function defaultState() { return { reliefRequests: [], coverageTracker: {} }; }

// ── Helpers ──────────────────────────────────────────────────────────────────
const DAYS   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function fmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
function fmtTime(t) {
  if (!t) return "";
  const [h,m] = t.split(":");
  const hh = +h;
  return `${((hh%12)||12)}:${m} ${hh>=12?"PM":"AM"}`;
}
function today()       { return new Date().toISOString().split("T")[0]; }
function isFriday(iso) { return new Date(iso+"T00:00:00").getDay()===5; }
function isWeekend(iso){ const d=new Date(iso+"T00:00:00").getDay(); return d===0||d===6; }
function monthKey(iso) { return iso.slice(0,7); }
function currentMonth(){ return today().slice(0,7); }

function buildGCalUrl(name, date, outBy, coveredBy) {
  const [h,m] = outBy.split(":");
  const start = `${date.replace(/-/g,"")}T${h}${m}00`;
  const hEnd  = String(+h+2).padStart(2,"0");
  const end   = `${date.replace(/-/g,"")}T${hEnd}${m}00`;
  const params = new URLSearchParams({
    action:"TEMPLATE", text:`Case Coverage: ${name} → ${coveredBy}`,
    dates:`${start}/${end}`,
    details:`${name} needs relief by ${outBy}. ${coveredBy} is covering.`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ── Validation ───────────────────────────────────────────────────────────────
function validateRequest(name, date, allRequests) {
  if (!name||!date) return "Name and date are required.";
  const mo = monthKey(date);
  const mine = allRequests.filter(r => r.name.toLowerCase()===name.toLowerCase() && monthKey(r.date)===mo);
  if (isFriday(date) && mine.filter(r=>isFriday(r.date)).length>=2)
    return `${name} has already used both Friday relief slots for ${MONTHS[+mo.split("-")[1]-1]}.`;
  if (mine.find(r=>r.coveredBy))
    return `${name} already had a case covered this month. Only 1 covered request per month allowed.`;
  return null;
}

// ── Per-person stats (all-time) ───────────────────────────────────────────────
function getAllProviderStats(allRequests, coverageTracker) {
  const stats = {};
  // seed from coverage tracker
  Object.entries(coverageTracker).forEach(([name, count]) => {
    if (!stats[name]) stats[name] = { requests:0, covered:0, coveredAsRequester:0, fridayReqs:0, weekendReqs:0 };
    stats[name].covered = count;
  });
  allRequests.forEach(r => {
    const n = r.name;
    if (!stats[n]) stats[n] = { requests:0, covered:0, coveredAsRequester:0, fridayReqs:0, weekendReqs:0 };
    stats[n].requests++;
    if (isFriday(r.date)) stats[n].fridayReqs++;
    if (isWeekend(r.date)) stats[n].weekendReqs++;
    if (r.coveredBy) stats[n].coveredAsRequester++;
  });
  return stats;
}

// ── Monthly calendar helpers ─────────────────────────────────────────────────
function getDaysInMonth(year, month) { return new Date(year, month+1, 0).getDate(); }
function getFirstDayOfMonth(year, month) { return new Date(year, month, 1).getDay(); }

// ── Name autocomplete ────────────────────────────────────────────────────────
function getBestMatch(input, names) {
  if (!input || input.length < 2) return null;
  const q = input.toLowerCase();
  return names.find(n => n.toLowerCase().startsWith(q) && n.toLowerCase()!==q) || null;
}

// ── AutocompleteInput ─────────────────────────────────────────────────────────
function AutocompleteInput({ value, onChange, allNames, style, placeholder }) {
  const suggestion = getBestMatch(value, allNames);
  const showSugg = suggestion && suggestion.toLowerCase() !== value.toLowerCase();
  const inputRef = useRef(null);

  function acceptSuggestion() {
    if (suggestion) onChange(suggestion);
  }

  function handleKey(e) {
    if ((e.key==="Tab"||e.key==="ArrowRight") && showSugg) {
      e.preventDefault();
      acceptSuggestion();
    }
  }

  return (
    <div style={{ position:"relative" }}>
      <input
        ref={inputRef}
        style={style}
        placeholder={placeholder}
        value={value}
        onChange={e=>onChange(e.target.value)}
        onKeyDown={handleKey}
        autoComplete="off"
      />
      {showSugg && (
        <div
          style={{
            position:"absolute", top:"100%", left:0, right:0, zIndex:20,
            background:"#0b1c2e", border:"1px solid #FFD10055", borderRadius:"0 0 10px 10px",
            padding:"0.55rem 1rem", cursor:"pointer",
            display:"flex", alignItems:"center", justifyContent:"space-between",
          }}
          onClick={acceptSuggestion}
        >
          <span style={{ color:"#d8eaff", fontFamily:"'DM Mono',monospace", fontSize:"0.86rem" }}>{suggestion}</span>
          <span style={{ color:"#FFD100", fontSize:"0.68rem", fontWeight:700, background:"#FFD10022", borderRadius:4, padding:"0.1rem 0.4rem" }}>Tab ↵</span>
        </div>
      )}
    </div>
  );
}

// ── Calendar View ─────────────────────────────────────────────────────────────
function CalendarView({ allRequests, onCoverCase }) {
  const now = new Date();
  const [calYear,  setCalYear ] = useState(now.getFullYear());
  const [calMonth, setCalMonth] = useState(now.getMonth());
  const [selected, setSelected] = useState(null); // req object

  const year = calYear, month = calMonth;
  const daysInMonth  = getDaysInMonth(year, month);
  const firstDay     = getFirstDayOfMonth(year, month);
  const monthIso     = `${year}-${String(month+1).padStart(2,"0")}`;

  const reqsThisMonth = allRequests.filter(r => monthKey(r.date)===monthIso);

  // map day -> requests
  const byDay = {};
  reqsThisMonth.forEach(r => {
    const day = +r.date.split("-")[2];
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(r);
  });

  function prevMonth() {
    if (calMonth===0) { setCalYear(y=>y-1); setCalMonth(11); }
    else setCalMonth(m=>m-1);
  }
  function nextMonth() {
    if (calMonth===11) { setCalYear(y=>y+1); setCalMonth(0); }
    else setCalMonth(m=>m+1);
  }

  const todayIso = today();
  const cells = [];
  for (let i=0;i<firstDay;i++) cells.push(null);
  for (let d=1;d<=daysInMonth;d++) cells.push(d);

  return (
    <div className="fade-up">
      {/* Month nav */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"1.2rem" }}>
        <div>
          <h1 style={{ fontFamily:"'Oswald'", fontSize:"2rem", color:"#FFD100", letterSpacing:"0.04em" }}>Case Calendar</h1>
          <p style={{ color:"#7a9ab8", fontSize:"0.78rem" }}>All relief requests by date</p>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:"0.5rem" }}>
          <button onClick={prevMonth} style={{ background:"#0b1c2e", border:"1px solid #1a3a5c", color:"#7a9ab8", borderRadius:8, width:32, height:32, cursor:"pointer", fontSize:"1rem", display:"flex", alignItems:"center", justifyContent:"center" }}>‹</button>
          <span style={{ color:"#d8eaff", fontFamily:"'Oswald'", fontSize:"1rem", letterSpacing:"0.05em", minWidth:140, textAlign:"center" }}>
            {MONTHS_FULL[month]} {year}
          </span>
          <button onClick={nextMonth} style={{ background:"#0b1c2e", border:"1px solid #1a3a5c", color:"#7a9ab8", borderRadius:8, width:32, height:32, cursor:"pointer", fontSize:"1rem", display:"flex", alignItems:"center", justifyContent:"center" }}>›</button>
        </div>
      </div>

      {/* Legend */}
      <div style={{ display:"flex", gap:"1rem", marginBottom:"0.9rem" }}>
        {[["#FFD100","Open"],["#2774AE","Covered"]].map(([c,l])=>(
          <div key={l} style={{ display:"flex", alignItems:"center", gap:"0.35rem" }}>
            <div style={{ width:10, height:10, borderRadius:3, background:c }}/>
            <span style={{ color:"#7a9ab8", fontSize:"0.72rem" }}>{l}</span>
          </div>
        ))}
      </div>

      {/* Day-of-week headers */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:"2px", marginBottom:"2px" }}>
        {DAYS.map(d=>(
          <div key={d} style={{ textAlign:"center", color:"#4a7aa0", fontSize:"0.68rem", fontWeight:700, fontFamily:"'DM Mono',monospace", letterSpacing:"0.08em", padding:"0.3rem 0" }}>
            {d.toUpperCase()}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:"2px" }}>
        {cells.map((day, i) => {
          if (!day) return <div key={`empty-${i}`} style={{ minHeight:72, background:"#071525", borderRadius:6 }}/>;
          const isoDay  = `${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
          const isToday = isoDay===todayIso;
          const dayReqs = byDay[day]||[];
          const hasOpen = dayReqs.some(r=>!r.coveredBy);
          const hasCovered = dayReqs.some(r=>r.coveredBy);
          const isFri = new Date(isoDay+"T00:00:00").getDay()===5;
          const isWknd = new Date(isoDay+"T00:00:00").getDay()%6===0;

          return (
            <div
              key={day}
              style={{
                minHeight:72, background: isToday?"#0d2040":"#071525",
                border:`1px solid ${isToday?"#FFD10066":dayReqs.length?"#1a3a5c":"#0f2245"}`,
                borderRadius:6, padding:"0.3rem 0.35rem", cursor:dayReqs.length?"pointer":"default",
                transition:"all 0.12s",
                position:"relative",
              }}
              onClick={()=>{ if(dayReqs.length===1) setSelected(dayReqs[0]); else if(dayReqs.length>1) setSelected({multiDay:isoDay, list:dayReqs}); }}
            >
              {/* Day number */}
              <div style={{
                fontSize:"0.72rem", fontWeight:700, fontFamily:"'DM Mono',monospace",
                color: isToday?"#FFD100": isFri?"#aac4e0": isWknd?"#7a9ab8":"#5a8aaa",
                marginBottom:"0.25rem",
              }}>{day}</div>

              {/* Request dots/chips */}
              <div style={{ display:"flex", flexDirection:"column", gap:"2px" }}>
                {dayReqs.slice(0,3).map((r,ri)=>(
                  <div key={ri} style={{
                    fontSize:"0.58rem", fontWeight:700, borderRadius:3, padding:"1px 3px",
                    background:r.coveredBy?"#2774AE22":"#FFD10022",
                    color:r.coveredBy?"#5ba8d4":"#FFD100",
                    border:`1px solid ${r.coveredBy?"#2774AE44":"#FFD10055"}`,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                  }}>
                    {r.name.split(" ").pop()}
                  </div>
                ))}
                {dayReqs.length>3 && (
                  <div style={{ fontSize:"0.58rem", color:"#7a9ab8" }}>+{dayReqs.length-3} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Detail modal */}
      {selected && (
        <div style={{ position:"fixed", inset:0, background:"#000b", zIndex:100, display:"flex", alignItems:"center", justifyContent:"center", padding:"1rem" }}
          onClick={()=>setSelected(null)}>
          <div style={{ background:"#0b1c2e", border:"1px solid #1a3a5c", borderRadius:16, padding:"1.5rem", maxWidth:400, width:"100%", maxHeight:"80vh", overflowY:"auto" }}
            onClick={e=>e.stopPropagation()}>

            {selected.multiDay ? (
              <>
                <h3 style={{ fontFamily:"'Oswald'", color:"#FFD100", fontSize:"1.3rem", marginBottom:"1rem" }}>
                  {fmtDate(selected.multiDay)}
                </h3>
                <div style={{ display:"flex", flexDirection:"column", gap:"0.7rem" }}>
                  {selected.list.map(r=>(
                    <div key={r.id} style={{ background:"#071525", border:`1px solid ${r.coveredBy?"#2774AE44":"#FFD10044"}`, borderRadius:10, padding:"0.85rem 1rem" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"0.4rem" }}>
                        <span style={{ color:"#d8eaff", fontWeight:600 }}>{r.name}</span>
                        <span style={{ fontSize:"0.7rem", fontWeight:700, color:r.coveredBy?"#5ba8d4":"#FFD100",
                          background:r.coveredBy?"#2774AE22":"#FFD10022", border:`1px solid ${r.coveredBy?"#2774AE55":"#FFD10055"}`,
                          borderRadius:20, padding:"0.15rem 0.6rem" }}>
                          {r.coveredBy?"✓ Covered":"● Open"}
                        </span>
                      </div>
                      <p style={{ color:"#7a9ab8", fontSize:"0.78rem", fontFamily:"'DM Mono',monospace" }}>Out by {fmtTime(r.outBy)}</p>
                      {r.coveredBy && <p style={{ color:"#5ba8d4", fontSize:"0.78rem", marginTop:"0.3rem" }}>Covered by: <strong>{r.coveredBy}</strong></p>}
                      {r.note && <p style={{ color:"#4a6a8a", fontSize:"0.75rem", marginTop:"0.3rem", fontStyle:"italic" }}>"{r.note}"</p>}
                      {!r.coveredBy && (
                        <button onClick={()=>{ onCoverCase(r.id); setSelected(null); }} style={{ marginTop:"0.5rem", width:"100%", background:"linear-gradient(135deg,#2774AE,#005587)", color:"#fff", border:"none", borderRadius:8, padding:"0.5rem", cursor:"pointer", fontFamily:"'DM Sans',sans-serif", fontSize:"0.78rem", fontWeight:600 }}>
                          ✅ Cover This Case
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:"1rem" }}>
                  <h3 style={{ fontFamily:"'Oswald'", color:"#FFD100", fontSize:"1.3rem" }}>{fmtDate(selected.date)}</h3>
                  <span style={{ fontSize:"0.72rem", fontWeight:700,
                    color:selected.coveredBy?"#5ba8d4":"#FFD100",
                    background:selected.coveredBy?"#2774AE22":"#FFD10022",
                    border:`1px solid ${selected.coveredBy?"#2774AE55":"#FFD10055"}`,
                    borderRadius:20, padding:"0.2rem 0.7rem" }}>
                    {selected.coveredBy?"✓ Covered":"● Open"}
                  </span>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:"0.7rem" }}>
                  <Row label="Requested by" value={selected.name} color="#d8eaff" />
                  <Row label="Relief time" value={fmtTime(selected.outBy)} color="#FFD100" />
                  {selected.coveredBy && <Row label="Covered by" value={selected.coveredBy} color="#5ba8d4" />}
                  {selected.coveredAt && <Row label="Covered at" value={new Date(selected.coveredAt).toLocaleString()} color="#7a9ab8" />}
                  {selected.note && <Row label="Note" value={selected.note} color="#7a9ab8" italic />}
                </div>
                {!selected.coveredBy && (
                  <button
                    onClick={()=>{ onCoverCase(selected.id); setSelected(null); }}
                    style={{ marginTop:"0.8rem", width:"100%", background:"linear-gradient(135deg,#2774AE,#005587)", color:"#fff", border:"none", borderRadius:10, padding:"0.75rem", cursor:"pointer", fontFamily:"'DM Sans',sans-serif", fontSize:"0.88rem", fontWeight:600 }}
                  >
                    ✅ Cover This Case
                  </button>
                )}
              </>
            )}
            <button onClick={()=>setSelected(null)} style={{ marginTop:"0.6rem", width:"100%", background:"transparent", border:"1px solid #1a3a5c", color:"#7a9ab8", borderRadius:8, padding:"0.65rem", cursor:"pointer", fontFamily:"'DM Sans',sans-serif", fontSize:"0.85rem" }}>
              Close
            </button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {reqsThisMonth.length===0 && (
        <div style={{ textAlign:"center", padding:"2rem", color:"#4a6a8a", marginTop:"1rem" }}>
          <div style={{ fontSize:"2rem", marginBottom:"0.5rem" }}>📅</div>
          <p style={{ fontSize:"0.88rem" }}>No relief requests in {MONTHS_FULL[month]}.</p>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, color, italic }) {
  return (
    <div style={{ background:"#071525", borderRadius:8, padding:"0.6rem 0.85rem" }}>
      <p style={{ color:"#4a7aa0", fontSize:"0.65rem", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:"0.2rem" }}>{label}</p>
      <p style={{ color:color||"#d8eaff", fontSize:"0.88rem", fontStyle:italic?"italic":"normal" }}>{value}</p>
    </div>
  );
}

// ── Residents View ────────────────────────────────────────────────────────────
function ResidentsView({ allRequests, coverageTracker }) {
  const stats = getAllProviderStats(allRequests, coverageTracker);
  const entries = Object.entries(stats).sort((a,b)=>
    (b[1].requests+b[1].covered) - (a[1].requests+a[1].covered)
  );
  const [expanded, setExpanded] = useState(null);

  if (entries.length===0) return (
    <div className="fade-up">
      <h1 style={{ fontFamily:"'Oswald'", fontSize:"2rem", color:"#FFD100", letterSpacing:"0.04em", marginBottom:"0.25rem" }}>Providers</h1>
      <div style={{ background:"#0b1c2e", border:"1px solid #1a3a5c", borderRadius:14, padding:"2.5rem", textAlign:"center", color:"#4a7aa0", marginTop:"1rem" }}>
        <div style={{ fontSize:"2rem", marginBottom:"0.5rem" }}>👤</div>
        <p style={{ fontSize:"0.88rem" }}>No providers yet. Data will appear once requests are submitted.</p>
      </div>
    </div>
  );

  return (
    <div className="fade-up">
      <h1 style={{ fontFamily:"'Oswald'", fontSize:"2rem", color:"#FFD100", letterSpacing:"0.04em", marginBottom:"0.2rem" }}>Providers</h1>
      <p style={{ color:"#7a9ab8", fontSize:"0.78rem", marginBottom:"1.2rem" }}>All-time stats per provider · {entries.length} provider{entries.length!==1?"s":""}</p>

      <div style={{ display:"flex", flexDirection:"column", gap:"0.6rem" }}>
        {entries.map(([name, s])=>{
          const fwPct = s.requests>0 ? Math.round(((s.fridayReqs+s.weekendReqs)/s.requests)*100) : 0;
          const friPct = s.requests>0 ? Math.round((s.fridayReqs/s.requests)*100) : 0;
          const wkndPct = s.requests>0 ? Math.round((s.weekendReqs/s.requests)*100) : 0;
          const isOpen = expanded===name;
          return (
            <div key={name} style={{ background:"#071525", border:`1px solid ${isOpen?"#FFD10055":"#0f2a45"}`, borderRadius:12, overflow:"hidden", transition:"border 0.15s" }}>
              {/* Header row */}
              <div
                style={{ padding:"0.9rem 1rem", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"space-between" }}
                onClick={()=>setExpanded(isOpen?null:name)}
              >
                <div style={{ display:"flex", alignItems:"center", gap:"0.7rem" }}>
                  <div style={{ width:34, height:34, borderRadius:"50%", background:"#0b1c2e", border:"1px solid #1a3a5c", display:"flex", alignItems:"center", justifyContent:"center", color:"#FFD100", fontWeight:700, fontSize:"0.8rem", fontFamily:"'Oswald'", flexShrink:0 }}>
                    {name.split(" ").map(w=>w[0]).slice(0,2).join("")}
                  </div>
                  <div>
                    <p style={{ color:"#d8eaff", fontWeight:600, fontSize:"0.9rem" }}>{name}</p>
                    <p style={{ color:"#4a7aa0", fontSize:"0.72rem", fontFamily:"'DM Mono',monospace" }}>
                      {s.requests} req · {s.covered} covered · {fwPct}% Fri/Wknd
                    </p>
                  </div>
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:"0.6rem" }}>
                  {/* mini stat pills */}
                  <span style={{ background:"#FFD10018", color:"#FFD100", border:"1px solid #FFD10033", borderRadius:20, padding:"0.15rem 0.55rem", fontSize:"0.68rem", fontWeight:700 }}>
                    {s.requests} reqs
                  </span>
                  <span style={{ background:"#2774AE22", color:"#5ba8d4", border:"1px solid #2774AE44", borderRadius:20, padding:"0.15rem 0.55rem", fontSize:"0.68rem", fontWeight:700 }}>
                    {s.covered} cvrd
                  </span>
                  <span style={{ color:"#4a7aa0", fontSize:"0.75rem" }}>{isOpen?"▲":"▼"}</span>
                </div>
              </div>

              {/* Expanded stats */}
              {isOpen && (
                <div style={{ borderTop:"1px solid #0f2a45", padding:"0.85rem 1rem", background:"#050f1a" }}>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.5rem", marginBottom:"0.8rem" }}>
                    {[
                      ["Total Requests", s.requests, "#FFD100"],
                      ["Cases Covered", s.covered, "#5ba8d4"],
                      ["Own Cases Covered", s.coveredAsRequester, "#C69214"],
                      ["Fri/Wknd Requests", s.fridayReqs+s.weekendReqs, "#e8a030"],
                    ].map(([label,val,color])=>(
                      <div key={label} style={{ background:"#071525", borderRadius:8, padding:"0.55rem 0.75rem" }}>
                        <p style={{ color:"#4a7aa0", fontSize:"0.63rem", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:"0.2rem" }}>{label}</p>
                        <p style={{ color:val>0?color:"#1a3a5a", fontFamily:"'DM Mono',monospace", fontSize:"1.1rem", fontWeight:700 }}>{val}</p>
                      </div>
                    ))}
                  </div>

                  {/* Breakdown bars */}
                  <div style={{ display:"flex", flexDirection:"column", gap:"0.45rem" }}>
                    <StatBar label="Friday requests" pct={friPct} color="#FFD100" />
                    <StatBar label="Weekend requests" pct={wkndPct} color="#e8a030" />
                    <StatBar label="Fri + Weekend % of total" pct={fwPct} color="#C69214" />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatBar({ label, pct, color }) {
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"0.2rem" }}>
        <span style={{ color:"#5a8aaa", fontSize:"0.74rem" }}>{label}</span>
        <span style={{ color:color, fontFamily:"'DM Mono',monospace", fontSize:"0.72rem", fontWeight:700 }}>{pct}%</span>
      </div>
      <div style={{ height:4, background:"#0f2a45", borderRadius:4, overflow:"hidden" }}>
        <div style={{ height:"100%", width:`${pct}%`, background:color, borderRadius:4, transition:"width 0.5s" }}/>
      </div>
    </div>
  );
}


// ── Google Sheets Export ──────────────────────────────────────────────────────
function exportToGoogleSheets(allRequests, coverageTracker) {
  const stats = getAllProviderStats(allRequests, coverageTracker);

  // Sheet 1: All Requests (raw data)
  const reqHeaders = ["ID","Provider","Date","Day","Relief Time","Covered By","Covered At","Note","Month","Year"];
  const reqRows = allRequests.map(r => {
    const d = new Date(r.date+"T00:00:00");
    return [
      r.id, r.name, r.date, DAYS[d.getDay()], r.outBy||"",
      r.coveredBy||"", r.coveredAt ? new Date(r.coveredAt).toLocaleDateString() : "",
      r.note||"", monthKey(r.date), r.date.slice(0,4)
    ];
  });

  // Sheet 2: Provider Stats
  const statHeaders = ["Provider","Total Requests","Cases Covered","Own Cases Covered","Friday Requests","Weekend Requests","Fri+Wknd %"];
  const statRows = Object.entries(stats).sort((a,b)=>b[1].requests-a[1].requests).map(([name,s])=>{
    const pct = s.requests>0 ? Math.round(((s.fridayReqs+s.weekendReqs)/s.requests)*100) : 0;
    return [name, s.requests, s.covered, s.coveredAsRequester, s.fridayReqs, s.weekendReqs, pct+"%"];
  });

  // Sheet 3: Monthly Summary
  const monthMap = {};
  allRequests.forEach(r => {
    const mk = monthKey(r.date);
    if (!monthMap[mk]) monthMap[mk] = { requests:0, covered:0, pending:0 };
    monthMap[mk].requests++;
    if (r.coveredBy) monthMap[mk].covered++; else monthMap[mk].pending++;
  });
  const monthHeaders = ["Month","Total Requests","Covered","Pending","Coverage Rate"];
  const monthRows = Object.entries(monthMap).sort().map(([mk,c])=>{
    const rate = c.requests>0 ? Math.round((c.covered/c.requests)*100) : 0;
    return [mk, c.requests, c.covered, c.pending, rate+"%"];
  });

  // Build a tab-separated string for each sheet, combine with sheet separators
  function buildTSV(headers, rows) {
    return [headers, ...rows].map(row => row.map(v=>String(v).replace(/\t/g," ").replace(/\n/g," ")).join("\t")).join("\n");
  }

  // We'll build CSV (comma-separated) and use Google Sheets import URL
  function buildCSV(headers, rows) {
    const escape = v => {
      const s = String(v);
      return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g,'""')}"` : s;
    };
    return [headers, ...rows].map(row => row.map(escape).join(",")).join("\n");
  }

  // Combine all sheets into one CSV with section headers
  const fullCSV = [
    "=== ALL REQUESTS ===",
    buildCSV(reqHeaders, reqRows),
    "",
    "=== PROVIDER STATS ===",
    buildCSV(statHeaders, statRows),
    "",
    "=== MONTHLY SUMMARY ===",
    buildCSV(monthHeaders, monthRows),
  ].join("\n");

  // Create a Blob and open it, then direct user to paste into Google Sheets
  const blob = new Blob([fullCSV], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = "UCLA_Anesthesia_Relief_Stats.csv";
  a.click();
  URL.revokeObjectURL(url);

  // Open Google Sheets in new tab
  setTimeout(() => {
    window.open("https://sheets.new", "_blank");
  }, 400);
}

// ── Main App ─────────────────────────────────────────────────────────────────
export default function ReliefApp() {
  const [data,   setData  ] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [view,   setView  ] = useState("board");

  const [rName,  setRName ] = useState("");
  const [rDate,  setRDate ] = useState(today());
  const [rOutBy, setROutBy] = useState("17:00");
  const [rNote,  setRNote ] = useState("");
  const [rError, setRError] = useState("");

  const [cReqId, setCReqId] = useState(null);
  const [cName,  setCName ] = useState("");

  const [success,    setSuccess   ] = useState(null);
  const [trackerTab, setTrackerTab] = useState("coverage");
  const [trackerPeriod, setTrackerPeriod] = useState("monthly"); // monthly | yearly | alltime

  useEffect(() => {
    (async () => {
      const stored = await loadData();
      setData(stored || defaultState());
      setLoaded(true);
    })();
  }, []);

  if (!loaded || !data) return (
    <div style={{ minHeight:"100vh", background:"#07111d", display:"flex", alignItems:"center", justifyContent:"center" }}>
      <p style={{ color:"#4a7aa0", fontFamily:"'DM Mono',monospace", letterSpacing:"0.05em" }}>Initiating case board…</p>
    </div>
  );

  const openRequests    = data.reliefRequests.filter(r => !r.coveredBy);
  const coveredRequests = data.reliefRequests.filter(r =>  r.coveredBy);
  const liveError = rName && rDate ? validateRequest(rName, rDate, data.reliefRequests) : null;
  const mo = currentMonth();

  // All known provider names (for autocomplete)
  const allNames = [...new Set([
    ...data.reliefRequests.map(r=>r.name),
    ...data.reliefRequests.map(r=>r.coveredBy).filter(Boolean),
    ...Object.keys(data.coverageTracker),
  ])].sort();

  function fridayQuota(name, month) {
    return data.reliefRequests.filter(r=>r.name.toLowerCase()===name.toLowerCase()&&monthKey(r.date)===month&&isFriday(r.date)).length;
  }

  async function submitRequest() {
    const err = validateRequest(rName, rDate, data.reliefRequests);
    if (err) { setRError(err); return; }
    const req = { id:Date.now(), name:rName, date:rDate, outBy:rOutBy, note:rNote, coveredBy:null, coveredAt:null };
    const next = { ...data, reliefRequests:[req,...data.reliefRequests] };
    setData(next); await saveData(next);
    setRName(""); setRNote(""); setRError("");
    setSuccess({ type:"requested", slot:`${fmtDate(rDate)} by ${fmtTime(rOutBy)}`, name:rName });
    setView("board");
  }

  async function submitCoverage() {
    if (!cName||!cReqId) return;
    const req = data.reliefRequests.find(r=>r.id===cReqId);
    const updated = data.reliefRequests.map(r=>r.id===cReqId?{...r,coveredBy:cName,coveredAt:new Date().toISOString()}:r);
    const tracker = {...data.coverageTracker,[cName]:(data.coverageTracker[cName]||0)+1};
    const next = {...data,reliefRequests:updated,coverageTracker:tracker};
    setData(next); await saveData(next);
    setCName(""); setCReqId(null);
    setSuccess({ type:"covered", name:cName, slot:`${fmtDate(req.date)} – covering ${req.name}`, gcalUrl:buildGCalUrl(req.name,req.date,req.outBy,cName) });
    setView("board");
  }

  const coverageEntries = Object.entries(data.coverageTracker).sort((a,b)=>b[1]-a[1]);
  const requestCounts   = (() => {
    const c={};
    data.reliefRequests.filter(r=>monthKey(r.date)===mo).forEach(r=>{
      if(!c[r.name])c[r.name]={total:0,covered:0,pending:0};
      c[r.name].total++;
      if(r.coveredBy)c[r.name].covered++;else c[r.name].pending++;
    });
    return c;
  })();
  const requestEntries = Object.entries(requestCounts).sort((a,b)=>b[1].total-a[1].total);

  const inp = { background:"#0b1c2e", border:"1px solid #1a3a5c", borderRadius:10, padding:"0.75rem 1rem", color:"#d8eaff", fontFamily:"'DM Mono',monospace", fontSize:"0.88rem", width:"100%", outline:"none" };
  const lbl = { color:"#8aaccc", fontSize:"0.72rem", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.1em", display:"block", marginBottom:"0.4rem" };

  const NAV = [
    ["board",    "🏥 Board"],
    ["request",  "💉 Request"],
    ["calendar", "📅 Calendar"],
    ["residents","👤 Providers"],
    ["tracker",  "📊 Tracker"],
  ];

  return (
    <div style={{ minHeight:"100vh", background:"#07111d", fontFamily:"'DM Sans',sans-serif", position:"relative" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&family=Oswald:wght@600;700&display=swap" rel="stylesheet"/>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar{width:4px;}::-webkit-scrollbar-thumb{background:#1a3a5c;border-radius:4px;}
        .nav-btn{background:none;border:none;cursor:pointer;padding:0.45rem 0.75rem;border-radius:8px;font-family:'DM Sans',sans-serif;font-size:0.78rem;font-weight:500;color:#4a7aa0;transition:all 0.15s;}
        .nav-btn.active{background:#071828;color:#FFD100;border:1px solid #FFD10044;}
        .nav-btn:hover:not(.active){color:#FFD100;}
        .card{background:#0b1c2e;border:1px solid #1a3a5c;border-radius:14px;padding:1.2rem;}
        .req-card{background:#071525;border:1px solid #0f2a45;border-radius:12px;padding:1rem 1.1rem;transition:border 0.15s;}
        .req-card:hover{border-color:#1a3a5c;}
        .tag{display:inline-flex;align-items:center;gap:0.3rem;border-radius:20px;padding:0.2rem 0.65rem;font-size:0.68rem;font-weight:700;letter-spacing:0.03em;}
        .tag-open{background:#1e1600;color:#FFD100;border:1px solid #FFD10044;}
        .tag-covered{background:#0d2040;color:#8aA8c8;border:1px solid #1a3050;}
        .tag-warn{background:#1e1800;color:#C69214;border:1px solid #3a2800;}
        .tag-block{background:#2a0a0a;color:#e05050;border:1px solid #4a1a1a;}
        .btn-primary{background:linear-gradient(135deg,#2774AE,#005587);color:#fff;border:none;border-radius:10px;padding:0.8rem 1.4rem;font-family:'DM Sans',sans-serif;font-size:0.9rem;font-weight:600;cursor:pointer;width:100%;transition:all 0.15s;}
        .btn-primary:hover:not(:disabled){filter:brightness(1.15);transform:translateY(-1px);}
        .btn-primary:disabled{opacity:0.35;cursor:not-allowed;}
        .btn-ghost{background:transparent;color:#4a7aa0;border:1px solid #2774AE44;border-radius:10px;padding:0.8rem 1.4rem;font-family:'DM Sans',sans-serif;font-size:0.88rem;font-weight:500;cursor:pointer;width:100%;transition:all 0.15s;}
        .btn-ghost:hover{border-color:#FFD100;color:#FFD100;}
        .btn-cover{background:linear-gradient(135deg,#1e1800,#0e1000);color:#FFD100;border:1px solid #3a2800;border-radius:8px;padding:0.42rem 0.85rem;font-family:'DM Sans',sans-serif;font-size:0.76rem;font-weight:700;cursor:pointer;transition:all 0.15s;white-space:nowrap;}
        .btn-cover:hover{filter:brightness(1.25);transform:translateY(-1px);}
        .select-card{background:#071525;border:2px solid #0f2a45;border-radius:10px;padding:0.85rem 1rem;cursor:pointer;transition:all 0.15s;}
        .select-card:hover{border-color:#FFD100;}
        .select-card.selected{border-color:#FFD100;background:#1e1800;}
        .rank-row{display:flex;align-items:center;gap:0.8rem;padding:0.7rem 0.9rem;border-radius:10px;background:#071525;border:1px solid #0f2a45;}
        .gcal-link{display:flex;align-items:center;justify-content:center;gap:0.6rem;background:#fff;color:#222;border-radius:10px;padding:0.8rem 1.4rem;font-family:'DM Sans',sans-serif;font-size:0.9rem;font-weight:600;text-decoration:none;transition:all 0.15s;width:100%;}
        .gcal-link:hover{background:#f0f0f0;transform:translateY(-1px);}
        .error-box{background:#1a0a0a;border:1px solid #4a1a1a;border-radius:10px;padding:0.75rem 1rem;color:#e05050;font-size:0.83rem;display:flex;gap:0.5rem;align-items:flex-start;line-height:1.5;}
        .pip{width:11px;height:11px;border-radius:50%;flex-shrink:0;}
        .tab-pill{background:none;border:none;cursor:pointer;padding:0.35rem 0.85rem;border-radius:20px;font-family:'DM Sans',sans-serif;font-size:0.78rem;font-weight:600;color:#4a7aa0;transition:all 0.15s;}
        .tab-pill.active{background:#1a3050;color:#FFD100;}
        .tab-pill:hover:not(.active){color:#FFD100;}
        input:focus,select:focus,textarea:focus{border-color:#FFD100 !important;}
        textarea{resize:vertical;}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
        .fade-up{animation:fadeUp 0.25s ease both;}
        .rules-strip{background:#071828;border:1px solid #FFD10022;border-radius:12px;padding:0.8rem 1rem;margin-bottom:1.2rem;display:flex;gap:1.2rem;flex-wrap:wrap;}
        .rule-item{display:flex;align-items:center;gap:0.4rem;}
        .rule-item span:first-child{font-size:0.85rem;}
        .rule-item span:last-child{color:#7a9ab8;font-size:0.73rem;font-weight:500;}
      `}</style>

      <div style={{ position:"fixed", inset:0, backgroundImage:"radial-gradient(circle at 15% 15%,#2774AE18,transparent 55%),radial-gradient(circle at 85% 85%,#FFD10010,transparent 50%)", pointerEvents:"none" }}/>
      <div style={{ position:"fixed", inset:0, backgroundImage:"linear-gradient(#163a6007 1px,transparent 1px),linear-gradient(90deg,#163a6007 1px,transparent 1px)", backgroundSize:"40px 40px", pointerEvents:"none" }}/>

      {/* Nav */}
      <div style={{ position:"sticky", top:0, zIndex:50, background:"#07111dee", backdropFilter:"blur(12px)", borderBottom:"1px solid #1a3a5c22", padding:"0.5rem 1rem", display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:"0.4rem" }}>
        <div style={{ display:"flex", alignItems:"center", gap:"0.5rem" }}>
          <span style={{ fontFamily:"'Oswald',sans-serif", fontSize:"1.1rem", color:"#FFD100", letterSpacing:"0.08em" }}>UCLA ANESTHESIA RELIEF</span>
          {openRequests.length>0 && <span style={{ background:"#FFD10020", color:"#FFD100", border:"1px solid #FFD10044", borderRadius:20, padding:"0.1rem 0.5rem", fontSize:"0.65rem", fontWeight:700 }}>{openRequests.length} open</span>}
        </div>
        <div style={{ display:"flex", gap:"0.15rem", flexWrap:"wrap" }}>
          {NAV.map(([v,l])=>(
            <button key={v} className={`nav-btn ${view===v?"active":""}`} onClick={()=>setView(v)}>{l}</button>
          ))}
        </div>
      </div>

      <div style={{ maxWidth:680, margin:"0 auto", padding:"1.5rem 1rem 4rem" }}>

        {/* SUCCESS OVERLAY */}
        {success && (
          <div style={{ position:"fixed", inset:0, background:"#000b", zIndex:100, display:"flex", alignItems:"center", justifyContent:"center", padding:"1rem" }}>
            <div className="card fade-up" style={{ maxWidth:380, width:"100%", textAlign:"center", padding:"2rem" }}>
              <div style={{ fontSize:"2.8rem", marginBottom:"0.75rem" }}>{success.type==="requested"?"💉":"✅"}</div>
              <h2 style={{ fontFamily:"'Oswald'", fontSize:"1.8rem", color:"#FFD100", letterSpacing:"0.04em", marginBottom:"0.4rem" }}>
                {success.type==="requested"?"Relief Requested! 💊":"Case Covered! 🫁"}
              </h2>
              <p style={{ color:"#7a9ab8", fontSize:"0.88rem", marginBottom:"1.4rem", lineHeight:1.6 }}>
                <strong style={{ color:"#FFD100" }}>{success.name}</strong><br/>{success.slot}
              </p>
              {success.gcalUrl && (
                <a href={success.gcalUrl} target="_blank" rel="noopener noreferrer" className="gcal-link" style={{ marginBottom:"0.75rem" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="17" rx="2" stroke="#4285F4" strokeWidth="2"/><path d="M3 9h18" stroke="#4285F4" strokeWidth="2"/><path d="M8 2v4M16 2v4" stroke="#4285F4" strokeWidth="2" strokeLinecap="round"/><rect x="7" y="13" width="4" height="3" rx="0.5" fill="#4285F4"/></svg>
                  Add to Google Calendar
                </a>
              )}
              <button className="btn-ghost" onClick={()=>setSuccess(null)}>Done</button>
            </div>
          </div>
        )}

        {/* ── BOARD ── */}
        {view==="board" && (
          <div className="fade-up">
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"1rem" }}>
              <div>
                <h1 style={{ fontFamily:"'Oswald'", fontSize:"2rem", color:"#FFD100", letterSpacing:"0.04em" }}>Open Relief Requests</h1>
                <p style={{ color:"#7a9ab8", fontSize:"0.78rem" }}>{openRequests.length} case{openRequests.length!==1?"s":""} need coverage · UCLA Anesthesia</p>
              </div>
              <button className="btn-cover" style={{ padding:"0.5rem 1rem" }} onClick={()=>setView("request")}>💉 Need Relief</button>
            </div>
            <div className="rules-strip">
              <div className="rule-item"><span>📅</span><span>Any day, any case</span></div>
              <div className="rule-item"><span>2️⃣</span><span>Max 2 Friday reliefs/month</span></div>
              <div className="rule-item"><span>🔒</span><span>1 covered case = no more requests this month</span></div>
            </div>
            {openRequests.length===0 && (
              <div className="card" style={{ textAlign:"center", padding:"2.5rem", color:"#4a7aa0", marginBottom:"1.2rem" }}>
                <div style={{ fontSize:"2rem", marginBottom:"0.5rem" }}>💉</div>
                <p style={{ fontSize:"0.9rem" }}>All cases covered! OR is fully staffed.</p>
              </div>
            )}
            <div style={{ display:"flex", flexDirection:"column", gap:"0.6rem", marginBottom:"1.4rem" }}>
              {openRequests.map(req=>{
                const used = fridayQuota(req.name, monthKey(req.date));
                return (
                  <div key={req.id} className="req-card">
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:"0.5rem" }}>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:"0.5rem", marginBottom:"0.3rem", flexWrap:"wrap" }}>
                          <span style={{ color:"#d8ecff", fontWeight:600, fontSize:"0.95rem" }}>{req.name}</span>
                          <span className="tag tag-open">🫁 Needs Relief</span>
                        </div>
                        <p style={{ color:"#4a7aa0", fontSize:"0.78rem", fontFamily:"'DM Mono',monospace" }}>
                          {fmtDate(req.date)} · Out by <strong style={{ color:"#FFD100" }}>{fmtTime(req.outBy)}</strong>
                        </p>
                        {req.note && <p style={{ color:"#2a4060", fontSize:"0.74rem", marginTop:"0.35rem", fontStyle:"italic" }}>"{req.note}"</p>}
                        <div style={{ display:"flex", alignItems:"center", gap:"0.5rem", marginTop:"0.5rem" }}>
                          <span style={{ color:"#1a3a5a", fontSize:"0.68rem" }}>Fri slots:</span>
                          {[0,1].map(i=>(
                            <div key={i} className="pip" style={{ background:i<used?"#FFD100":"#0f2a45", border:`1px solid ${i<used?"#C69214":"#1a3a58"}` }}/>
                          ))}
                          <span style={{ color:used>=2?"#e05050":"#4a7aa0", fontSize:"0.68rem", fontFamily:"'DM Mono',monospace" }}>{used}/2</span>
                        </div>
                      </div>
                      <button className="btn-cover" onClick={()=>{ setCReqId(req.id); setView("cover"); }}>Cover Case →</button>
                    </div>
                  </div>
                );
              })}
            </div>
            {coveredRequests.length>0 && (
              <>
                <p style={{ ...lbl, marginBottom:"0.6rem" }}>Recently Covered Cases</p>
                <div style={{ display:"flex", flexDirection:"column", gap:"0.4rem" }}>
                  {coveredRequests.slice(0,5).map(req=>(
                    <div key={req.id} className="req-card" style={{ opacity:0.5 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                        <span style={{ color:"#5a7a9a", fontSize:"0.85rem" }}>{req.name} <span style={{ color:"#1a3a5a", fontFamily:"'DM Mono',monospace", fontSize:"0.74rem" }}>· {fmtDate(req.date)}</span></span>
                        <div style={{ display:"flex", alignItems:"center", gap:"0.4rem" }}>
                          <span style={{ color:"#1a3a5a", fontSize:"0.72rem" }}>→</span>
                          <span className="tag tag-covered">{req.coveredBy}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── REQUEST RELIEF ── */}
        {view==="request" && (
          <div className="fade-up">
            <button onClick={()=>setView("board")} style={{ background:"none", border:"none", color:"#7a9ab8", cursor:"pointer", fontSize:"0.83rem", marginBottom:"1.2rem" }}>← Back to Board</button>
            <h1 style={{ fontFamily:"'Oswald'", fontSize:"2rem", color:"#FFD100", letterSpacing:"0.04em", marginBottom:"0.2rem" }}>Request Case Relief</h1>
            <p style={{ color:"#7a9ab8", fontSize:"0.78rem", marginBottom:"1.4rem" }}>Any day · Max 2 Friday reliefs/month · 1 covered case locks you out for the month</p>
            <div className="card" style={{ display:"flex", flexDirection:"column", gap:"1rem" }}>
              <div>
                <label style={lbl}>Provider Name</label>
                <AutocompleteInput value={rName} onChange={v=>{ setRName(v); setRError(""); }} allNames={allNames} style={inp} placeholder="e.g. Dr. Rivera, CRNA Johnson"/>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.75rem" }}>
                <div>
                  <label style={lbl}>Date</label>
                  <input type="date" style={inp} value={rDate} onChange={e=>{ setRDate(e.target.value); setRError(""); }}/>
                </div>
                <div>
                  <label style={lbl}>Relief Time Needed</label>
                  <input type="time" style={inp} value={rOutBy} onChange={e=>setROutBy(e.target.value)}/>
                </div>
              </div>
              {rName && (
                <div style={{ background:"#071525", border:"1px solid #0f2a45", borderRadius:10, padding:"0.8rem 1rem" }}>
                  <p style={{ ...lbl, marginBottom:"0.6rem" }}>{MONTHS[+mo.split("-")[1]-1]} usage for {rName}</p>
                  {(() => {
                    const myReqs = data.reliefRequests.filter(r=>r.name.toLowerCase()===rName.toLowerCase()&&monthKey(r.date)===mo);
                    const fridaysUsed = myReqs.filter(r=>isFriday(r.date)).length;
                    const coveredThisMonth = myReqs.find(r=>r.coveredBy);
                    return (
                      <div style={{ display:"flex", flexDirection:"column", gap:"0.5rem" }}>
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                          <span style={{ color:"#5a8aaa", fontSize:"0.8rem" }}>Total relief requests</span>
                          <span style={{ color:"#FFD100", fontFamily:"'DM Mono',monospace", fontSize:"0.76rem", fontWeight:700 }}>{myReqs.length}</span>
                        </div>
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                          <span style={{ color:"#5a8aaa", fontSize:"0.8rem" }}>Friday relief slots</span>
                          <div style={{ display:"flex", gap:"0.35rem", alignItems:"center" }}>
                            {[0,1].map(i=>(<div key={i} className="pip" style={{ background:i<fridaysUsed?"#FFD100":"#0f2a45", border:`1px solid ${i<fridaysUsed?"#C69214":"#1a3a58"}` }}/>))}
                            <span style={{ color:fridaysUsed>=2?"#e05050":"#5ba8d4", fontFamily:"'DM Mono',monospace", fontSize:"0.76rem", marginLeft:"0.3rem" }}>{fridaysUsed}/2</span>
                          </div>
                        </div>
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                          <span style={{ color:"#5a8aaa", fontSize:"0.8rem" }}>Case covered this month</span>
                          <span style={{ color:coveredThisMonth?"#e05050":"#FFD100", fontSize:"0.76rem", fontWeight:700 }}>
                            {coveredThisMonth?"🔒 Case limit reached":"✓ Clear"}
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
              <div>
                <label style={lbl}>Note (optional)</label>
                <textarea style={{ ...inp, minHeight:68 }} placeholder="Case details, room number, reason for relief…" value={rNote} onChange={e=>setRNote(e.target.value)}/>
              </div>
              {(rError||liveError) && <div className="error-box"><span>⚠️</span><span>{rError||liveError}</span></div>}
              <button className="btn-primary" disabled={!rName||!rDate||!rOutBy||!!liveError} onClick={submitRequest}>💉 Post Relief Request</button>
            </div>
          </div>
        )}

        {/* ── COVER A CASE ── */}
        {view==="cover" && (
          <div className="fade-up">
            <button onClick={()=>setView("board")} style={{ background:"none", border:"none", color:"#7a9ab8", cursor:"pointer", fontSize:"0.83rem", marginBottom:"1.2rem" }}>← Back to Board</button>
            <h1 style={{ fontFamily:"'Oswald'", fontSize:"2rem", color:"#FFD100", letterSpacing:"0.04em", marginBottom:"0.2rem" }}>Cover a Case</h1>
            <p style={{ color:"#7a9ab8", fontSize:"0.78rem", marginBottom:"1.4rem" }}>Select the case you're covering. This will be logged and tracked.</p>
            <div className="card" style={{ display:"flex", flexDirection:"column", gap:"1rem" }}>
              <div>
                <label style={lbl}>Select Case to Cover</label>
                <div style={{ display:"flex", flexDirection:"column", gap:"0.45rem" }}>
                  {openRequests.length===0 && <p style={{ color:"#7a9ab8", fontSize:"0.85rem" }}>No open relief requests right now.</p>}
                  {openRequests.map(req=>(
                    <div key={req.id} className={`select-card ${cReqId===req.id?"selected":""}`} onClick={()=>setCReqId(req.id)}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                        <div>
                          <p style={{ color:"#e8f0ff", fontWeight:600, fontSize:"0.88rem" }}>{req.name}</p>
                          <p style={{ color:"#7a9ab8", fontSize:"0.75rem", fontFamily:"'DM Mono',monospace" }}>{fmtDate(req.date)} · Out by {fmtTime(req.outBy)}</p>
                        </div>
                        <div style={{ width:16, height:16, borderRadius:"50%", border:`2px solid ${cReqId===req.id?"#FFD100":"#163350"}`, background:cReqId===req.id?"#FFD100":"transparent", flexShrink:0 }}/>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <label style={lbl}>Your Name</label>
                <AutocompleteInput value={cName} onChange={setCName} allNames={allNames} style={inp} placeholder="e.g. Dr. Kim"/>
              </div>
              <button className="btn-primary" disabled={!cName||!cReqId||openRequests.length===0} onClick={submitCoverage}>✅ Confirm Coverage</button>
            </div>
          </div>
        )}

        {/* ── CALENDAR ── */}
        {view==="calendar" && <CalendarView allRequests={data.reliefRequests} onCoverCase={(id)=>{ setCReqId(id); setView("cover"); }}/>}

        {/* ── PROVIDERS / RESIDENTS ── */}
        {view==="residents" && <ResidentsView allRequests={data.reliefRequests} coverageTracker={data.coverageTracker}/>}

        {/* ── TRACKER ── */}
        {view==="tracker" && (
          <div className="fade-up">
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:"0.25rem", flexWrap:"wrap", gap:"0.5rem" }}>
              <div>
                <h1 style={{ fontFamily:"'Oswald'", fontSize:"2rem", color:"#FFD100", letterSpacing:"0.04em" }}>Case Tracker</h1>
                <p style={{ color:"#7a9ab8", fontSize:"0.78rem" }}>Coverage leaders · Relief requests per provider</p>
              </div>
              <button onClick={()=>exportToGoogleSheets(data.reliefRequests, data.coverageTracker)} style={{ background:"linear-gradient(135deg,#1a8a3a,#0d5a25)", color:"#fff", border:"none", borderRadius:8, padding:"0.5rem 0.9rem", cursor:"pointer", fontFamily:"'DM Sans',sans-serif", fontSize:"0.76rem", fontWeight:700, display:"flex", alignItems:"center", gap:"0.4rem", whiteSpace:"nowrap" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="2" y="3" width="20" height="18" rx="2" stroke="#fff" strokeWidth="2"/><path d="M8 3v18M16 3v18M2 9h20M2 15h20" stroke="#fff" strokeWidth="1.5"/></svg>
                Export to Google Sheets
              </button>
            </div>

            {/* Period selector */}
            <div style={{ display:"flex", gap:"0.3rem", background:"#071828", border:"1px solid #1a3a5c", borderRadius:10, padding:"0.3rem", marginBottom:"0.6rem", width:"fit-content" }}>
              {[["monthly","📅 Monthly"],["yearly","📆 Yearly"],["alltime","🏆 All-Time"]].map(([p,l])=>(
                <button key={p} className={`tab-pill ${trackerPeriod===p?"active":""}`} onClick={()=>setTrackerPeriod(p)}>{l}</button>
              ))}
            </div>

            <div style={{ display:"flex", gap:"0.3rem", background:"#071828", border:"1px solid #1a3a5c", borderRadius:10, padding:"0.3rem", marginBottom:"1.2rem", width:"fit-content" }}>
              <button className={`tab-pill ${trackerTab==="coverage"?"active":""}`} onClick={()=>setTrackerTab("coverage")}>🏥 Coverage Leaders</button>
              <button className={`tab-pill ${trackerTab==="requests"?"active":""}`} onClick={()=>setTrackerTab("requests")}>📋 Requests</button>
            </div>

            {trackerTab==="coverage" && (() => {
              // Build coverage counts for the selected period
              const periodCovReqs = trackerPeriod==="monthly"
                ? data.reliefRequests.filter(r=>monthKey(r.date)===mo && r.coveredBy)
                : trackerPeriod==="yearly"
                  ? data.reliefRequests.filter(r=>r.date.startsWith(new Date().getFullYear().toString()) && r.coveredBy)
                  : data.reliefRequests.filter(r=>r.coveredBy);
              const periodCovMap = {};
              periodCovReqs.forEach(r => { periodCovMap[r.coveredBy]=(periodCovMap[r.coveredBy]||0)+1; });
              // For all-time, also count from tracker (covers any manual entries)
              if (trackerPeriod==="alltime") {
                Object.entries(data.coverageTracker).forEach(([name,count]) => {
                  periodCovMap[name] = count; // use tracker as authoritative for all-time
                });
              }
              const periodCovEntries = Object.entries(periodCovMap).sort((a,b)=>b[1]-a[1]);
              const periodLabel = trackerPeriod==="monthly" ? `${MONTHS[+mo.split("-")[1]-1]} ${mo.split("-")[0]}` : trackerPeriod==="yearly" ? new Date().getFullYear().toString() : "All Time";
              return (
                <>
                  <p style={{ color:"#7a9ab8", fontSize:"0.74rem", marginBottom:"0.8rem" }}>Period: <strong style={{ color:"#FFD100" }}>{periodLabel}</strong></p>
                  {periodCovEntries.length===0 && (
                    <div className="card" style={{ textAlign:"center", padding:"2rem", color:"#7a9ab8" }}>
                      <div style={{ fontSize:"2rem", marginBottom:"0.5rem" }}>📊</div>
                      <p style={{ fontSize:"0.88rem" }}>No coverage recorded for this period.</p>
                    </div>
                  )}
                  <div style={{ display:"flex", flexDirection:"column", gap:"0.5rem" }}>
                    {periodCovEntries.map(([name,count],i)=>{
                      const pct=(count/(periodCovEntries[0]?.[1]||1))*100;
                      return (
                        <div key={name} className="rank-row">
                          <div style={{ width:26, textAlign:"center", flexShrink:0 }}>
                            {i<3?<span style={{ fontSize:"1.1rem" }}>{["🥇","🥈","🥉"][i]}</span>
                                :<span style={{ color:"#1a3a5a", fontFamily:"'DM Mono',monospace", fontSize:"0.76rem" }}>#{i+1}</span>}
                          </div>
                          <div style={{ flex:1 }}>
                            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"0.3rem" }}>
                              <span style={{ color:"#e8f0ff", fontWeight:500, fontSize:"0.86rem" }}>{name}</span>
                              <span style={{ color:i===0?"#FFD100":i===1?"#c8d8f0":i===2?"#5ba8d4":"#7a9ab8", fontFamily:"'DM Mono',monospace", fontSize:"0.8rem", fontWeight:700 }}>
                                {count} case{count!==1?"s":""}
                              </span>
                            </div>
                            <div style={{ height:3, background:"#0f2a45", borderRadius:4, overflow:"hidden" }}>
                              <div style={{ height:"100%", width:`${pct}%`, background:i===0?"linear-gradient(90deg,#FFD100,#C69214)":i===1?"linear-gradient(90deg,#c8d8f0,#9ab0c8)":i===2?"linear-gradient(90deg,#2774AE,#005587)":"linear-gradient(90deg,#2774AE66,#00558766)", borderRadius:4, transition:"width 0.5s" }}/>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {periodCovEntries.length>0 && (
                    <div className="card" style={{ marginTop:"1rem", display:"flex", justifyContent:"space-between" }}>
                      <div><p style={{ color:"#7a9ab8", fontSize:"0.7rem", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em" }}>Cases Covered</p>
                        <p style={{ color:"#FFD100", fontFamily:"'Oswald'", fontSize:"1.8rem" }}>{periodCovEntries.reduce((s,[,c])=>s+c,0)}</p></div>
                      <div style={{ textAlign:"right" }}><p style={{ color:"#7a9ab8", fontSize:"0.7rem", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em" }}>Providers</p>
                        <p style={{ color:"#FFD100", fontFamily:"'Oswald'", fontSize:"1.8rem" }}>{periodCovEntries.length}</p></div>
                    </div>
                  )}
                </>
              );
            })()}

            {trackerTab==="requests" && (() => {
              const periodLabel = trackerPeriod==="monthly" ? `${MONTHS[+mo.split("-")[1]-1]} ${mo.split("-")[0]}` : trackerPeriod==="yearly" ? new Date().getFullYear().toString() : "All Time";
              const periodReqs = trackerPeriod==="monthly"
                ? data.reliefRequests.filter(r=>monthKey(r.date)===mo)
                : trackerPeriod==="yearly"
                  ? data.reliefRequests.filter(r=>r.date.startsWith(new Date().getFullYear().toString()))
                  : data.reliefRequests;
              const pCounts = {};
              periodReqs.forEach(r=>{
                if(!pCounts[r.name])pCounts[r.name]={total:0,covered:0,pending:0,fridays:0};
                pCounts[r.name].total++;
                if(r.coveredBy)pCounts[r.name].covered++;else pCounts[r.name].pending++;
                if(isFriday(r.date))pCounts[r.name].fridays++;
              });
              const pEntries=Object.entries(pCounts).sort((a,b)=>b[1].total-a[1].total);
              return (
                <>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"0.8rem" }}>
                    <p style={{ color:"#7a9ab8", fontSize:"0.76rem" }}>Period: <strong style={{ color:"#FFD100" }}>{periodLabel}</strong></p>
                    <div style={{ display:"flex", gap:"0.75rem" }}>
                      {[["#2774AE","Pending"],["#FFD100","Covered"],["#e05050","Blocked"]].map(([c,l])=>(
                        <div key={l} style={{ display:"flex", alignItems:"center", gap:"0.3rem" }}>
                          <div style={{ width:7, height:7, borderRadius:"50%", background:c }}/>
                          <span style={{ color:"#7a9ab8", fontSize:"0.68rem" }}>{l}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {pEntries.length===0 && (
                    <div className="card" style={{ textAlign:"center", padding:"2rem", color:"#7a9ab8" }}>
                      <div style={{ fontSize:"2rem", marginBottom:"0.5rem" }}>📆</div>
                      <p style={{ fontSize:"0.88rem" }}>No relief requests for this period.</p>
                    </div>
                  )}
                  <div style={{ display:"flex", flexDirection:"column", gap:"0.5rem" }}>
                    {pEntries.map(([name,counts])=>{
                      const isBlocked=trackerPeriod==="monthly"&&counts.covered>0;
                      const slotsUsed=counts.total;
                      const friPct=slotsUsed>0?Math.round((counts.fridays/slotsUsed)*100):0;
                      return (
                        <div key={name} style={{ background:"#071525", border:"1px solid #0f2a45", borderRadius:12, padding:"0.9rem 1rem" }}>
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.6rem" }}>
                            <div style={{ display:"flex", alignItems:"center", gap:"0.5rem" }}>
                              <span style={{ color:"#e8f0ff", fontWeight:600, fontSize:"0.9rem" }}>{name}</span>
                              {isBlocked&&<span className="tag tag-block">🔒 Case limit</span>}
                              {!isBlocked&&trackerPeriod==="monthly"&&slotsUsed>=2&&<span className="tag tag-warn">⚠ Friday limit</span>}
                            </div>
                            {trackerPeriod==="monthly" && (
                              <div style={{ display:"flex", gap:"0.3rem", alignItems:"center" }}>
                                {[0,1].map(i=>(
                                  <div key={i} className="pip" style={{ width:13, height:13, background:i<slotsUsed?(i<counts.covered?"#FFD100":"#2774AE"):"#163350", border:`1.5px solid ${i<slotsUsed?(i<counts.covered?"#C69214":"#1a6aaf"):"#1a3a58"}` }}/>
                                ))}
                                <span style={{ color:"#7a9ab8", fontFamily:"'DM Mono',monospace", fontSize:"0.72rem", marginLeft:"0.2rem" }}>{slotsUsed}/2</span>
                              </div>
                            )}
                          </div>
                          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:"0.5rem" }}>
                            {[["Requests",slotsUsed,"#FFD100"],["Covered",counts.covered,"#C69214"],["Pending",counts.pending,"#2774AE"],["% Fridays",friPct+"%","#e8a030"]].map(([label,val,color])=>(
                              <div key={label} style={{ background:"#0b1c2e", borderRadius:8, padding:"0.5rem 0.7rem" }}>
                                <p style={{ color:"#7a9ab8", fontSize:"0.6rem", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:"0.2rem" }}>{label}</p>
                                <p style={{ color:(typeof val==="number"?val:parseInt(val))>0?color:"#1a3a5a", fontFamily:"'DM Mono',monospace", fontSize:"1rem", fontWeight:700 }}>{val}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
