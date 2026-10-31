import sys,re,json
s=open(sys.argv[1],encoding='utf-8').read()
m=re.search(r'var __prefetch_doc_data__ = (\{.*?\});\s*(var |$)',s,re.S)
data=json.JSONDecoder().raw_decode(s[s.find('var __prefetch_doc_data__ = ')+len('var __prefetch_doc_data__ = '):])[0]
# find string fields that are JSON doc trees
found=[]
def walk(o):
    if isinstance(o,dict):
        for v in o.values(): walk(v)
    elif isinstance(o,list):
        for v in o: walk(v)
    elif isinstance(o,str) and o[:1] in '{[' and '"type"' in o and len(o)>5000:
        try: found.append(json.loads(o))
        except Exception: pass
walk(data)
def text(n):
    if n is None: return ''
    if isinstance(n,list): return ''.join(text(c) for c in n)
    t=n.get('type')
    if t=='text': return n.get('text') or ''
    if t=='structured_table_datepicker': return (n.get('attrs') or {}).get('value') or ''
    if t in ('reference','footnote','ref','citation'): return ''
    return text(n.get('children'))
out=[]
def block(n):
    t=n.get('type'); ch=n.get('children') or []
    if t=='heading':
        out.append('\n'+'#'*n['attrs']['level']+' '+text(ch).strip())
    elif t=='paragraph':
        x=text(ch).strip()
        if x: out.append(x)
    elif t=='infobox_key':
        out.append('INFOKEY:'+text(ch).strip())
    elif t=='infobox_value':
        out.append('INFOVAL:'+text(ch).strip())
    elif t=='table':
        rows=[]
        for r in ch:
            cells=[text(c).strip().replace('\n',' ').replace('|','/') for c in (r.get('children') or [])]
            rows.append(cells)
        if rows:
            w=max(len(r) for r in rows)
            for i,r in enumerate(rows):
                out.append('| '+' | '.join(r+['']*(w-len(r)))+' |')
                if i==0: out.append('|'+' --- |'*w)
            out.append('')
    elif t=='structured_table':
        for mod in n['attrs'].get('module',[]):
            slot=mod.get('slot',{})
            parts=[]
            for k,v in slot.items():
                if k in ('poster',): continue
                x=text(v).strip().replace('\n',' ')
                if x: parts.append(f'{k}: {x}')
            if parts: out.append('- '+'；'.join(parts))
        out.append('')
    elif t in ('image','video','block_image'):
        pass
    else:
        for c in ch:
            if isinstance(c,dict): block(c)
for d in found:
    for n in (d if isinstance(d,list) else [d]):
        if isinstance(n,dict): block(n)
    out.append('\n---\n')
o2=[]
for l in out:
    if l.startswith('INFOVAL:') and o2 and o2[-1].startswith('INFOKEY:'):
        o2[-1]='- '+o2[-1][8:]+'：'+l[8:]
    elif l.startswith('INFOKEY:') or l.startswith('INFOVAL:'): o2.append(l)
    else: o2.append(l)
md='\n'.join(x.replace('INFOKEY:','- ').replace('INFOVAL:','  ') for x in o2)
md=re.sub(r'\[\d+(-\d+)?\]','',md)
open(sys.argv[2],'w').write(md)
print(len(found), len(md))
