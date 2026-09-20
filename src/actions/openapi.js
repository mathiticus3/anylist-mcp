import {zodToJsonSchema} from 'zod-to-json-schema';
import {PROJECTION} from './projection.js';
import {VERSION} from '../stable/capabilities.js';
export const ADAPTER_VERSION='1.0.0';
const str={type:'string'}, num={type:'number'}, bool={type:'boolean'};
const nullable=s=>({anyOf:[s,{type:'null'}]});
const array=items=>({type:'array',items});
const object=(properties,required=[])=>({type:'object',properties,...(required.length?{required}:{}),additionalProperties:false});
const ref=name=>({$ref:'#/components/schemas/'+name});
const identity=object({identifier:str,name:str},['identifier','name']);
const error=object({ok:{const:false},error:object({code:str,message:str,candidates:array(object({id:str,name:str},['id','name'])),fields:array(str)},['code','message'])},['ok','error']);
const item=object({identifier:str,name:str,quantity:{type:['number','string']},checked:bool,note:nullable(str),category:str,store:nullable(str),storeIds:array(str),categoryAssignments:array(object({categoryGroupId:str,categoryId:str})),manualSortIndex:nullable(num)},['identifier','name','quantity','checked']);
const ingredient=object({identifier:str,name:str,quantity:str,rawIngredient:str,note:str,isHeading:bool});
const recipe=object({identifier:nullable(str),name:str,note:nullable(str),sourceName:nullable(str),sourceUrl:nullable(str),prepTime:nullable(num),cookTime:nullable(num),servings:nullable(str),rating:nullable(num),nutritionalInfo:nullable(str),scaleFactor:nullable(num),photoIds:nullable(array(str)),photoUrls:nullable(array(str)),creationTimestamp:nullable(num),timestamp:nullable(num),paprikaIdentifier:nullable(str),adCampaignId:nullable(str),ingredients:array(ingredient),preparationSteps:array(str)},['name']);
const collection=object({identifier:str,name:str,recipeIds:array(str)},['identifier','name','recipeIds']);
const category=object({identifier:str,name:str,systemCategory:str,sortIndex:num});
const event=object({identifier:str,date:str,title:nullable(str),details:nullable(str),recipeId:nullable(str),labelId:nullable(str),recipeName:nullable(str),labelName:nullable(str),recipeScaleFactor:nullable(num),orderAddedSortIndex:nullable(num)},['identifier','date']);
const manifestFields={version:str,serverVersion:str,clientVersion:str,clientCommit:str,capabilities:array(object({tool:str,action:str,operationId:str,description:str,effect:{enum:['read','write','delete']}},['tool','action','operationId','description','effect']))};
const success=fields=>object({ok:{const:true},...fields},['ok']);
function responseFor(entry) {
 const id=entry.operationId;
 if(id==='listShoppingLists')return success({lists:array(object({identifier:str,name:str,itemCount:num,uncheckedCount:num},['identifier','name','itemCount','uncheckedCount']))});
 if(id==='getShoppingList')return success({list:str,listId:str,categorySet:nullable(str),items:array(ref('Item'))});
 if(id==='getShoppingReferenceData')return success({list:identity,items:array(ref('Item')),stores:array(identity),categorySets:array(object({identifier:str,name:str,defaultCategory:nullable(str),categories:array(identity)}))});
 if(id==='listFavorites')return success({list:identity,items:array(ref('Item'))});
 if(id==='manageCategory')return success({list:identity,category,deleted:bool,name:str});
 if(id==='addShoppingItems')return success({list:identity,complete:bool,results:array({anyOf:[success({item:ref('Item')}),object({...error.properties,name:str},['ok','error'])]})});
 if(['addShoppingItem','updateShoppingItem','checkShoppingItem','uncheckShoppingItem','saveFavorite'].includes(id))return success({list:identity,item:ref('Item')});
 if(id==='getServiceStatus')return success({ready:bool,synchronizedAt:str,...manifestFields});
 if(id.startsWith('delete')||id==='removeFavorite')return success({deleted:bool,identifier:str,list:identity});
 if(id==='listRecipes')return success({total:num,offset:num,recipes:array(ref('Recipe'))});
 if(['getRecipe','createRecipe','updateRecipe','normalizeRecipe','importRecipe'].includes(id))return success({recipe:ref('Recipe'),saved:bool});
 if(id==='listRecipeCollections')return success({collections:array(ref('Collection')),collection:ref('Collection'),recipes:array(identity)});
 if(id==='createRecipeCollection')return success({collection:ref('Collection')});
 if(id==='setRecipeCollectionMembership')return success({collection:ref('Collection'),recipeId:str,present:bool});
 if(id==='getMealPlan')return success({events:array(ref('Event'))});
 if(id==='listMealLabels')return success({labels:array(object({identifier:str,name:str,hexColor:nullable(str),sortIndex:nullable(num)}))});
 if(['addMealPlanEvent','updateMealPlanEvent'].includes(id))return success({event:ref('Event')});
 throw Error('Missing response schema: '+id);
}
export function openapi() {
 const paths={};
 for(const entry of PROJECTION) {
  const schema=zodToJsonSchema(entry.schema,{$refStrategy:'none',target:'jsonSchema7'});delete schema.$schema;
  const description=entry.description+' '+(entry.effect==='read'?'':'Writes are not transactional. After a timeout or transport error, read current state; never blindly retry.');
  paths['/actions/'+entry.operationId]={post:{operationId:entry.operationId,summary:entry.operationId,description:description.slice(0,300),'x-openai-isConsequential':entry.effect==='delete',requestBody:{required:true,content:{'application/json':{schema}}},responses:{200:{description:'Structured MCP result; canonical IDs are retained.',content:{'application/json':{schema:responseFor(entry)}}},...Object.fromEntries([400,401,404,409,413,422,429,502].map(status=>[status,{description:({400:'Invalid input',401:'Missing or revoked dedicated credential',404:'Resource not found',409:'Ambiguous identity or conflict',413:'Input or response too large',422:'Unsupported capability',429:'Rate limited',502:'AnyList authentication, transport or upstream failure; write outcome may be unknown'})[status],content:{'application/json':{schema:ref('Error')}}}]))}}};
 }
 return {openapi:'3.1.0',info:{title:'Vector72 AnyList',version:ADAPTER_VERSION,description:`Private owner Actions projection over AnyList MCP ${VERSION}. AnyList is the source of truth. Select exact IDs on ambiguity. Add item is an upsert. Meal update supports details only.`, 'x-mcp-version':VERSION},servers:[{url:'https://anylist.vector72.io'}],security:[{gptBearer:[]}],paths,components:{securitySchemes:{gptBearer:{type:'http',scheme:'bearer',description:'Dedicated independently revocable owner GPT credential; not an AnyList password or MCP token.'}},schemas:{Error:error,Item:item,Recipe:recipe,Collection:collection,Event:event}}};
}
