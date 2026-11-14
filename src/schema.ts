const number={type:'number'};
const body={type:'object',required:['azimuth_deg','elevation_deg'],properties:{azimuth_deg:number,elevation_deg:number},additionalProperties:false};
const conditions={type:'object',required:['sun_visible','earth_visible','co_visibility'],properties:{sun_visible:{type:'boolean'},earth_visible:{type:'boolean'},co_visibility:{type:'boolean'}},additionalProperties:false};
export const masterSchema={type:'object',required:['site_id','horizon_mask','ephemeris_timeline','heightmap_url','windows','metrics','resolution','provenance'],properties:{
 site_id:{type:'string'},coordinates:{type:'object',additionalProperties:true},target:{type:'object',additionalProperties:true},heightmap:{type:'object',additionalProperties:true},heightmap_url:{type:'string'},observer_height_m:number,
 horizon_mask:{type:'array',items:{type:'object',required:['azimuth_deg','max_elevation_deg'],properties:{azimuth_deg:number,max_elevation_deg:number}}},
 ephemeris_timeline:{type:'array',items:{type:'object',required:['timestamp_utc','sun','earth','conditions'],properties:{timestamp_utc:{type:'string'},sun:body,earth:body,conditions}}},
 windows:{type:'array',items:{type:'object',additionalProperties:true}},metrics:{type:'object',additionalProperties:true},resolution:{type:'object',additionalProperties:true},provenance:{type:'object',additionalProperties:true}
},additionalProperties:false};
