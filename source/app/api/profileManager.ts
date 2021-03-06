//Create the datastore.
const Store = require("electron-store");
const store = new Store();

//required for caching profile pictures.
const fs = require('fs');
const path = require('path');

//Prepare a basic axios instance to communicate with the leafal API.
var qs = require('qs');
import axios from 'axios';
const LeafalAPI = axios.create({
    baseURL: 'https://www.leafal.io/api/',
    headers: {
        "Client-Id": process.env.PUBLIC_KEY
    }
});

//define all interfaces.
interface ProfileTemplate {
    id: number,                     //Used to identify a profile
    username: string,               //Used to identify a profile
    token: string | null,           //Used to store the token for the application if a profile is signedin / authenticated
    signedin: boolean,              //Used to quickly indicate if a profile is authenicated.
    updated: number,                //States when locally cached profile was last updated.
    displayname: string | number,   //Cached: Display name set by user, referred in the API as "name"
    url: string,                    //Cached: User's profile url
    avatar: string,                 //Cached: User's online avatar url
    localAvatar: string,            //Cached: User's offline avatar url
    coin: {                         //Cached: User's avatar coin
        color: string,
        title: string,
        desktop: string
    }
}

//define all types;
type ProfileTemplateItem = 'id' | 'username' | 'token' | 'signedin' | 'updated' | 'displayname' | 'url' | 'avatar' | 'localAvatar' | 'coin';

//Profile class. manage a profile, or create a new one (via ProfileManager).
class Profile {
    private profile: ProfileTemplate;   //Stores the profile
    private doUpdates: boolean;         //Defines if updates should be pushed. (Used when an unexpected input is provided, will act as a dummy Profile and is unusable)

    constructor(profile: ProfileTemplate, doUpdates: boolean = true) {
        this.profile = profile;         //Globally store the profile data in the class.
        this.doUpdates = doUpdates;     //Globally define the doUpdate state in the class.

        if (!profile) {                 //If the input is unexpected and invalid, load a dummy profile and prevent updates to the datastore.
            this.doUpdates = false;
            this.profile = {
                id: 0,
                username: '',
                token: null,
                signedin: false,
                updated: -1,
                displayname: '',
                url: '',
                avatar: '',
                localAvatar: '',
                coin: {
                    color: '',
                    title: '',
                    desktop: ''
                }
            }
        } else if (!store.get('userprofiles').find((profile: any) => profile && profile.id === this.profile.id) && this.doUpdates) {
            //If updates are allowed, and the profile does not yet exist in the datastore, register it in the next index.
            store.set('userprofiles.' + store.get('userprofiles').length, this.profile);
        }

        //Update the profile cache upon loading. (function itself got a limiting factor of once per 2 minutes, unless the force parameter is set to true)
        this.updateCache();
    }

    //Authenticate / sign in a profile.
    async authenticate(password: string) {
        if (!this.doUpdates) return false;                          //Prevent a dummy profile from being authenticated.
        var result: any = await LeafalAPI.post('desktop/token/index.php', qs.stringify({
            username: this.profile.username,
            password: password
        }));

        result = result.data;
        if (result.success === false) {
            return result;
        } else {                            //If authentication is successful, update the token and update the profile.
            this.setToken(result.token);
            this.update();
            return {
                success: true,
                token: result.token
            };
        }      
    }

    //Signout / deauthenticate a profile
    signout() {
        if (!this.doUpdates) return false;  //Prevent a dummy profile from being signedout.
        this.profile.signedin = false;      //Update the signedin indicator.
        this.profile.token = null;          //Remove the token from the profile.
        this.update();                      //Update the profile.
        return true;
    }

    setToken(token: string) {
        if (!this.doUpdates) return false;  //Prevent the token of a dummy profile to be set.
        if (this.validToken(token)) {       //Validate the provided token against the username of the profile.
            this.profile.token = token;     //Update the token in the profile.
            this.profile.signedin = true;   //Update the signedin indicator of the profile.
            this.update();                  //Update the profile
            return true;
        } else {
            return false;                   //Provide a negative response if the token is invalid / doesnt belong to the profile.
        }
    }

    //Get item from profile.
    get(item?: ProfileTemplateItem) {
        switch(item) {                      //Allows for special behaviour for certain items.
            case 'token': 
                return this.profile.signedin ? this.profile.token : null;
            default:
                return (item ? this.profile[item] : this.profile);
        }
    }

    //validate a token againt the username of the profile.
    validToken(token: string) {
        if (!this.doUpdates) return false;
        return Promise.resolve((resolve: any, reject: any) => {
            LeafalAPI.post('users/me/index.php', {}, {              //Obtain information about the profile linked to provided token. (if valid)
                headers: {
                    "Authorization": `Bearer ${token}`
                }
            }).then(res => {
                if (res.data.success === false) {                   //Token is invalid, provide a negative response.
                    resolve(false);
                } else {    
                    resolve(res.data.id == this.profile.id);        //If token matches local profile, return true. Else provide a negative response.
                }
            }).catch(err => reject(err));
        });
    }

    //Obtain an axios instance, special to the currently signedin profile.
    obtainAPI() {
        if (!this.doUpdates) return false;
        if (this.profile.signedin) {        //Check if profile is signedin
            return axios.create({
                baseURL: 'https://www.leafal.io/api/',
                headers: {
                    "Client-Id": process.env.PUBLIC_KEY,
                    "Authorization": `Bearer ${this.profile.token}`
                }
            });
        } else {
            return null;                    //Return null, since profile is not signedin
        }
    }

    //INTERNAL CLASS USE ONLY: update the local profile in the datastore.
    private update() {
        if (!this.doUpdates) return false;
        store.get('userprofiles').forEach((profile: ProfileTemplate, i: number) => {                        //Loop through all locally stored profiles.
            if (profile && profile.id == this.profile.id) store.set('userprofiles.' + i, this.profile);     //If profile matches, update it.
        });
    }

    //update the cached profile.
    async updateCache(force: boolean = false) {
        if (!this.doUpdates) return false;
        if (!force && Math.floor((new Date().getTime() - this.profile.updated) / 60000) < 2) {   //unless forced, check if at least two minutes have passed since the last update.
            return false;                                                                       //Two minutes have not yet passed, provide a negative response.
        } else {
            const res = await LeafalAPI.post('users/index.php', qs.stringify({                  //obtain the profile, independent of the authentication status.
                username: this.profile.username
            }));
            
            if (res.data.success === false) {                                                   //check if errors have occured.
                return false;
            } else {
                if (force || res.data.avatar !== this.profile.avatar) {                                  //If online profile picture has updated, cache local picture.
                    await axios({
                        url: res.data.avatar,
                        method: 'get',
                        responseType: 'stream'
                    }).then(imgRes => {
                        const targetFile = ([this.profile.id, res.data.avatar.split('.').pop()]).join('.');
                        const stream = fs.createWriteStream(path.dirname(path.dirname(__dirname)) + '/static/img/profile/' + targetFile);
                        this.profile.localAvatar = 'img/profile/' + targetFile;
                        this.update();
                        imgRes.data.pipe(stream);
                    });
                }
    
                //Update all information.
                this.profile.updated = new Date().getTime();
                this.profile.displayname = res.data.name;
                this.profile.url = res.data.url;
                this.profile.avatar = res.data.avatar;
                this.profile.coin = res.data.coin;

                this.update(); //Update the profile in the local datastore.    
                return true;
            }
        }

        
    }

    //Delete profile from local datastore.
    delete() {
        if (!this.doUpdates) return false;
        store.get('userprofiles').forEach((profile: ProfileTemplate, i: number) => {
            if (profile && profile.id == this.profile.id) store.delete('userprofiles.' + i);
        });
    }
}

class ProfileManager {
    constructor() {
        if (!store.get('userprofiles')) store.set('userprofiles', []); //Make sure local datastore for userprofiles is ready.
    }

    //List all user profiles.
    list() {
        var profiles: any[] = [];
        store.get('userprofiles').forEach((item: ProfileTemplate, i: number) => item ? profiles.push(new Profile(item)) : 0); //Wrap all profiles in Profile class.
        return profiles;
    }

    //Find a user in local datastore, and return Profile if found.
    find(username: string) {
        var profile = store.get('userprofiles').find((profile: any) => profile && profile.username === username);
        if (profile) profile = new Profile(profile);
        return profile;
    }

    //Check if user exists in local datastore.
    exists(username: string) {
        var profile = store.get('userprofiles').find((profile: any) => profile && profile.username === username);
        return profile ? true : false;
    }

    //Obtain profile from online API, independent of the profile being in existance in local datastore.
    async obtain(input: string | number, isId: boolean = false) {
        var data = isId ? {id:input} : {username:input};                                //Obtain by id if isId == true.
        var res: any = await LeafalAPI.post('users/index.php', qs.stringify(data));     //Obtain from API.
        return Object.assign({
            success: true
        }, res.data);
    }

    async updateCaches(force: boolean = false) {
        const profs = this.list();
        for (var i = 0; i < profs.length; i++) {
            await profs[i].updateCache(force);
        }
        
        return true;
    }

    //Create new user.
    async create(username: string) {   
        if (!this.exists(username)) {                           //Check if user exists.
            var profile = await this.obtain(username);          //Obtain profile from online API.
            if (profile.success) {                              //If profile exists online, proceed creation of local profile.
                return new Profile({                            //Partially prefill information.
                    id: parseInt(profile.id),
                    username: profile.username,
                    token: null,
                    signedin: false,
                    updated: 0,
                    displayname: profile.name,
                    url: profile.url,
                    avatar: '',
                    localAvatar: profile.avatar,
                    coin: profile.coin
                });
            } else {
                return false;                                   //Profile does not exist online, provide negative response.
            }
        } else {
            return false;                                       //Profile already exists in local datastore.
        }
    }

    //Delete a profile by username.
    delete(username: string) {
        ((profile: Profile | null) => !profile ? false : profile.delete())(this.find(username))     //Find profile and delete it.
    }
}

module.exports = new ProfileManager;