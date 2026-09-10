/* STARFALL ADVANCED SYSTEMS
   Browser-safe progression/profile layer. The game can use this now without a server.
   A future server can replace these methods with authenticated API calls.
*/
window.StarfallSystems={
  profile:{
    load(){return {best:+localStorage.starfallBest||0,kills:+localStorage.starfallKills||0,missions:+localStorage.starfallMissions||0,unlocked:+localStorage.starfallUnlocked||0}},
    save(data){if(data.best!=null)localStorage.starfallBest=data.best;if(data.kills!=null)localStorage.starfallKills=data.kills;if(data.missions!=null)localStorage.starfallMissions=data.missions;if(data.unlocked!=null)localStorage.starfallUnlocked=data.unlocked}
  },
  events:{
    record(type,data){let key='starfallEvents';let events=JSON.parse(localStorage[key]||'[]');events.push({type,data:data||{},time:new Date().toISOString()});localStorage[key]=JSON.stringify(events.slice(-100))}
  }
};
