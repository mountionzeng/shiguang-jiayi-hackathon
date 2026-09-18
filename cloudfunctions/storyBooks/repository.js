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

module.exports={createDocumentAdapter,writableDocument};
