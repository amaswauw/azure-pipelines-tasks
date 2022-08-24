"use strict";

import AuthenticationTokenProvider from "./authenticationtokenprovider";
import { ApplicationTokenCredentials } from "azure-pipelines-tasks-azure-arm-rest-v2/azure-arm-common";
import RegistryAuthenticationToken from "./registryauthenticationtoken";
import * as tl from "azure-pipelines-task-lib/task";
import * as Q from "q";
import * as webClient from "azure-pipelines-tasks-azure-arm-rest-v2/webClient";

export default class ACRAuthenticationTokenProvider extends AuthenticationTokenProvider{

    // URL to registry like jitekuma-microsoft.azurecr.io
    private registryURL: string;

    // name of the azure subscription endpoint like RMDev
    private endpointName: string;

    // ACR fragment like /subscriptions/c00d16c7-6c1f-4c03-9be1-6934a4c49682/resourcegroups/jitekuma-RG/providers/Microsoft.ContainerRegistry/registries/jitekuma
    private acrFragmentUrl: string;

    constructor(endpointName?: string, registerNameValue?: string) {
        super();

        if(endpointName && registerNameValue) 
        {
            try
            {
              tl.debug("Reading the acr registry in old versions");
              var obj = JSON.parse(registerNameValue);  
              this.registryURL = obj.loginServer;
              this.acrFragmentUrl = obj.id;
            }  
            catch(e)
            {
              tl.debug("Reading the acr registry in kubernetesV1");
              this.registryURL = registerNameValue;
            }
  
            this.endpointName = endpointName;
        }
    }
    
    public getAuthenticationToken(): RegistryAuthenticationToken
    {
        if(this.registryURL && this.endpointName) {      
            return new RegistryAuthenticationToken(tl.getEndpointAuthorizationParameter(this.endpointName, 'serviceprincipalid', true), tl.getEndpointAuthorizationParameter(this.endpointName, 'serviceprincipalkey', true), this.registryURL, "ServicePrincipal@AzureRM", this.getXMetaSourceClient());
        }
        return null;
    }

    public async getToken(): Promise<RegistryAuthenticationToken> {
        let authType: string;
        // Will error out with an internal error if the parameter is not found. This error is determined inside of the
        // tl.getEndpointAuthorizationScheme/tl.getEndpointAuthorizationParameter and cannot be caught here as it is a
        // custom error.
        try {
            authType = tl.getEndpointAuthorizationScheme(this.endpointName, false);
        } catch (error) {
        }
        try {
            authType = tl.getEndpointAuthorizationParameter(this.endpointName, "scheme", false);
        } catch (error) {
        }
        if (!authType) {
            authType = "ServicePrincipal";
        }
        if (authType == "ManagedServiceIdentity") {
            // Parameter 1: retryCount - the current retry count of the method to get the ACR token through MSI authentication
            // Parameter 2: timeToWait - the current time wait of the method to get the ACR token through MSI authentication
            return await this._getMSIAuthenticationToken(0, 0);
        } else {
            return this.getAuthenticationToken();
        }
    }

    private static async _getACRToken(AADToken: string, endpointName: string, registryURL: string, retryCount: number, timeToWait: number): Promise<string> {
        let deferred = Q.defer<string>();
        let tenantID = tl.getEndpointAuthorizationParameter(endpointName, 'tenantid', true);
        let webRequest = new webClient.WebRequest();
        webRequest.method = "POST";
        const retryLimit = 5
        webRequest.uri = `https://${registryURL}/oauth2/exchange`;
        webRequest.body = (
            `grant_type=access_token&service=${registryURL}&tenant=${tenantID}&access_token=${AADToken}`
        );
        webRequest.headers = {
            "Content-Type": "application/x-www-form-urlencoded"
        };
        webClient.sendRequest(webRequest).then(
            (response: webClient.WebResponse) => {
                if (response.statusCode === 200) {
                    deferred.resolve(response.body.refresh_token);
                }
                else if (response.statusCode == 429 || response.statusCode == 500) {
                    if (retryCount < retryLimit) {
                        let waitedTime = 2000 + timeToWait * 2;
                        retryCount += 1;
                        setTimeout(() => {
                            deferred.resolve(this._getACRToken(AADToken, endpointName, registryURL, retryCount, waitedTime));
                        }, waitedTime);
                    }
                    else {
                        deferred.reject(tl.loc('CouldNotFetchAccessTokenforACRStatusCode', response.statusCode, response.statusMessage));
                    }
                }
                else {
                    deferred.reject(tl.loc('CouldNotFetchAccessTokenforMSIDueToACRNotConfiguredProperlyStatusCode', response.statusCode, response.statusMessage));
                }
            },
            (error) => {
                deferred.reject(error)
            }
        );
        return deferred.promise;
    }

    private async _getMSIAuthenticationToken(retryCount: number, timeToWait: number): Promise<RegistryAuthenticationToken> {
        if (this.registryURL && this.endpointName) {
            try {
                let aadtoken = await ApplicationTokenCredentials.getMSIAuthorizationToken(
                    retryCount, timeToWait, "https://management.core.windows.net/", null);
                let acrToken = await ACRAuthenticationTokenProvider._getACRToken(aadtoken, this.endpointName, this.registryURL, retryCount, timeToWait);
                return new RegistryAuthenticationToken(
                    "00000000-0000-0000-0000-000000000000", acrToken, this.registryURL,
                    "ManagedIdentity@AzureRM", this.getXMetaSourceClient());
            } catch (error) {
                throw new Error(tl.loc("MSIFetchError"));
            }
        }
        throw new Error(tl.loc("MSIFetchError"));
    }
}