// Parse only the projection boundary of our trusted, generated SELECT sources.
// Function arguments, CASE expressions, comments and nested SELECTs must never
// be mistaken for output columns (e.g. COALESCE(u.name,u.email) AS requester).
export function historyProjectionFields(sql,columns,details=false) {
  const text=sql.trim().replace(/^SELECT\s+/i,'');
  let depth=0,quote=null,start=0,from=-1;const parts=[];
  for(let i=0;i<text.length;i++){
    const char=text[i];
    if(quote){if(char===quote){if(text[i+1]===quote)i++;else quote=null;}continue;}
    if(char==="'"||char==='"'){quote=char;continue;}
    if(char==='-'&&text[i+1]==='-'){const end=text.indexOf('\n',i);i=end<0?text.length:end;continue;}
    if(char==='/'&&text[i+1]==='*'){const end=text.indexOf('*/',i+2);i=end<0?text.length:end+1;continue;}
    if(char==='(')depth++;else if(char===')')depth--;
    if(depth===0&&(i===0||!/[a-z0-9_$.]/i.test(text[i-1]))&&/^FROM\b/i.test(text.slice(i))){parts.push(text.slice(start,i).trim());from=i+4;break;}
    if(depth===0&&char===','){parts.push(text.slice(start,i).trim());start=i+1;}
  }
  if(from<0)parts.push(text.slice(start).trim());
  let wildcard=new Set(columns?.keys()||[]);
  const rest=from<0?'':text.slice(from).trim();
  if(rest.startsWith('(')){
    let level=1,q=null;
    for(let i=1;i<rest.length;i++){
      const char=rest[i];
      if(q){if(char===q){if(rest[i+1]===q)i++;else q=null;}continue;}
      if(char==="'"||char==='"'){q=char;continue;}
      if(char==='(')level++;else if(char===')')level--;
      if(level===0){wildcard=historyProjectionFields(rest.slice(1,i),columns);break;}
    }
  }
  const fields=new Set();
  for(const part of parts){
    if(/^(?:[a-z_][a-z0-9_]*\.)?\*$/i.test(part)){for(const field of wildcard)fields.add(field);continue;}
    const alias=part.match(/\bAS\s+([a-z_][a-z0-9_]*)\s*$/i);
    const bare=part.match(/^(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)$/i);
    if(alias||bare)fields.add((alias||bare)[1]);
  }
  return details?{fields,parts,rest,wildcard}:fields;
}

/** Expand only trusted source wildcards. Explicit aliases win, matching JSON's
 * existing last-column behavior without introducing ambiguous derived columns. */
export function historySourceSql(sql,columns,required) {
  if(!columns)return sql;
  const {parts,rest,wildcard}=historyProjectionFields(sql,columns,true);
  const explicit=new Set();
  for(const part of parts){
    const alias=part.match(/\bAS\s+([a-z_][a-z0-9_]*)\s*$/i);
    const bare=part.match(/^(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)$/i);
    if(alias||bare)explicit.add((alias||bare)[1]);
  }
  const selected=parts.flatMap(part=>{
    const star=part.match(/^(?:([a-z_][a-z0-9_]*)\.)?\*$/i);
    if(!star)return[part];
    return [...wildcard].filter(field=>!explicit.has(field)&&(!required||required.has(field)))
      .map(field=>`${star[1]?`${star[1]}.`:''}"${field.replaceAll('"','""')}"`);
  });
  return `SELECT ${selected.join(',')} FROM ${rest}`;
}
