const missing=error=>/does not exist|not found|cannot find document/i.test(String(error?.errMsg || error?.message || error));

function writableDocument(value) {
  const {_id,...data}=value || {};
  return data;
}

function createDocumentAdapter(target) {
  return {
    async get(table,id){try{return (await target.collection(table).doc(id).get()).data;}catch(error){if(missing(error))return undefined;throw error;}},
    async set(table,id,value){await target.collection(table).doc(id).set({data:writableDocument(value)});},
    async remove(table,id){await target.collection(table).doc(id).remove();},
  };
}

// Family scope comes from the authorized context, never from extra filters.
async function readFamilyDocuments(db,table,familyId,fields,filter={}) {
  const rows=[];
  for(let offset=0;;offset+=100) {
    let query=db.collection(table).where({...filter,familyId}).orderBy('_id','asc').skip(offset).limit(100);
    if(fields)query=query.field(fields);
    const result=await query.get();
    rows.push(...result.data);
    if(result.data.length<100)return rows;
  }
}

module.exports={createDocumentAdapter,writableDocument,readFamilyDocuments};
